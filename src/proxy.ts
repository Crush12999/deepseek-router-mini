import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouterConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import type { PublicModelConfig, RawConfig } from "./config-schema.js";
import type { TierEntry } from "./config-schema.js";
import { createModelRegistry } from "./model-registry.js";
import type { ModelRegistry } from "./model-registry.js";
import { resolvePublicModelCandidate } from "./public-model-resolver.js";
import {
  DEFAULT_ROUTING_CONFIG,
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  route,
  resolveTraceWriter,
} from "./router/index.js";
import type {
  ModelPricing,
  RouteTraceLog,
  RoutingConfig,
  RoutingDecision,
  TraceAttempt,
  TraceLogger,
  TraceReason,
  TraceSessionAction,
  Tier,
  TierConfig,
} from "./router/index.js";
import type { RouterOptions } from "./router/types.js";
import type { SessionConfig } from "./session.js";
import { deriveSessionId, SessionStore } from "./session.js";

export const VERSION = "0.2.0";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const PUBLIC_HEADER_PREFIXES = [
  "x-xiaoyi-router-",
  ["x", "deepseek", "router"].join("-") + "-",
] as const;

export type ProxyOptions = {
  config: RawConfig;
  traceLogger?: TraceLogger;
  session?: Partial<SessionConfig>;
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

type ExtractedPrompt = {
  text: string;
  routeText: string;
  system?: string;
  openingText: string;
};

const OPENCLAW_CLI_TURN_PATTERN =
  /(?:^|\n)\[[^\]\n]+?\]\s+([\s\S]*?)(?=(?:\n\[[^\]\n]+?\]\s+)|$)/g;

function extractRouteTextFromUserMessage(text: string): string {
  const matches = [...text.matchAll(OPENCLAW_CLI_TURN_PATTERN)];
  const last = matches.at(-1)?.[1]?.trim();
  return last || text;
}

function extractPrompt(messages: unknown[]): ExtractedPrompt {
  const parts: string[] = [];
  let system: string | undefined;
  let openingText = "";
  let lastUserText = "";

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    const role: unknown = (msg as Record<string, unknown>).role;
    const content: unknown = (msg as Record<string, unknown>).content;

    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (p): p is { type: string; text?: string } =>
            typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "text",
        )
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join(" ");
    }

    if (role === "system") {
      system = system ? `${system}\n${text}` : text;
    } else {
      parts.push(text);
      if (role === "user" && text.trim()) {
        lastUserText = extractRouteTextFromUserMessage(text);
      }
      if (!openingText && text.trim()) {
        openingText = text;
      }
    }
  }

  const text = parts.join(" ");
  return { text, routeText: lastUserText || text, system, openingText };
}

// ---------------------------------------------------------------------------
// Upstream headers
// ---------------------------------------------------------------------------

function buildUpstreamHeaders(req: IncomingMessage, cfg: RouterConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  const setHeader = (key: string, value: string): void => {
    const existingKey = Object.keys(headers).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existingKey) {
      delete headers[existingKey];
    }
    headers[key] = value;
  };

  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value !== undefined) {
      setHeader(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  // Custom headers override request headers
  for (const [key, value] of Object.entries(cfg.headers)) {
    setHeader(key, value);
  }

  // Add auth if missing (header names are case-insensitive per HTTP spec)
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (!hasAuth && cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  // Ensure content-type is set
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    setHeader("content-type", "application/json");
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}

function writeJsonWithHeaders(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  writeJson(res, status, body);
}

function copyResponseHeaders(response: Response, extraHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (PUBLIC_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    headers[key] = value;
  }
  Object.assign(headers, extraHeaders);
  return headers;
}

async function streamResponse(response: Response, res: ServerResponse): Promise<void> {
  if (response.body) {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  }
  res.end();
}

function writeOpenAiError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string = "invalid_request_error",
  code: string | null = null,
  headers?: Record<string, string>,
): void {
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }

  writeJson(res, status, {
    error: {
      message,
      type,
      param: null,
      code,
    },
  });
}

// ---------------------------------------------------------------------------
// Upstream fetch with retryable detection
// ---------------------------------------------------------------------------

type AttemptResult =
  | { ok: true; response: Response }
  | { ok: false; reason: "retryable"; response: Response }
  | { ok: false; reason: "network_error"; error: unknown };

async function fetchUpstream(
  cfg: ReturnType<typeof resolveConfig>,
  req: IncomingMessage,
  body: Record<string, unknown>,
  actualModel: string,
): Promise<AttemptResult> {
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildUpstreamHeaders(req, cfg),
      body: JSON.stringify({ ...body, model: actualModel }),
    });

    if (RETRYABLE_STATUS.has(response.status)) {
      return { ok: false, reason: "retryable", response };
    }

    return { ok: true, response };
  } catch (error) {
    return { ok: false, reason: "network_error", error };
  }
}

type SelectedModel = {
  routedModel: string;
  actualModel: string;
  tier: Tier;
  decision?: RoutingDecision;
  routeText: string;
  requestedModel: string;
  sessionId?: string;
  routed: boolean;
  explicit: boolean;
  sessionAction: TraceSessionAction;
};

function getMaxOutputTokens(body: Record<string, unknown>): number {
  const maxTokens = body.max_tokens;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.ceil(maxTokens);
  }

  const maxCompletionTokens = body.max_completion_tokens;
  if (
    typeof maxCompletionTokens === "number" &&
    Number.isFinite(maxCompletionTokens) &&
    maxCompletionTokens > 0
  ) {
    return Math.ceil(maxCompletionTokens);
  }

  return 1024;
}

function buildRouterOptions(options: { routingConfig: RoutingConfig; modelPricing: Map<string, ModelPricing> }): RouterOptions {
  return {
    config: options.routingConfig,
    modelPricing: options.modelPricing,
  };
}

function buildRoutingConfigFromRawConfig(rawConfig: RawConfig): RoutingConfig {
  return {
    ...DEFAULT_ROUTING_CONFIG,
    tiers: mapRawTierEntries(rawConfig.routing.tiers),
    overrides: {
      structuredOutputMinTier: rawConfig.routing.structuredOutputMinTier ?? "MEDIUM",
      ambiguousDefaultTier: rawConfig.routing.ambiguousDefaultTier ?? "MEDIUM",
    },
  };
}

function mapRawTierEntries(entries: Record<Tier, TierEntry>): Record<Tier, TierConfig> {
  return Object.fromEntries(
    Object.entries(entries).map(([tier, entry]) => [
      tier,
      {
        primary: entry.publicModel,
        fallback: entry.fallback ?? [],
      },
    ]),
  ) as Record<Tier, TierConfig>;
}

function buildModelPricingFromPublicModels(
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
): Map<string, ModelPricing> {
  return new Map(
    Object.entries(publicModels).map(([publicModelId, config]) => {
      if (config.kind === "router") {
        return [
          publicModelId,
          {
            inputPrice: config.metadata.cost.input,
            outputPrice: config.metadata.cost.output,
          },
        ];
      }

      const physicalModel = resolvePublicModelCandidate(publicModelId, publicModels, registry);
      return [
        publicModelId,
        {
          inputPrice: physicalModel.inputPrice,
          outputPrice: physicalModel.outputPrice,
        },
      ];
    }),
  );
}

const TIER_ORDER: Record<Tier, number> = {
  SIMPLE: 0,
  MEDIUM: 1,
  COMPLEX: 2,
  REASONING: 3,
};

function isLowerTier(nextTier: Tier, pinnedTier: Tier): boolean {
  return TIER_ORDER[nextTier] < TIER_ORDER[pinnedTier];
}

function getExplicitTier(publicModelId: string, entries: Record<Tier, TierEntry>): Tier {
  const matches = (Object.entries(entries) as Array<[Tier, TierEntry]>)
    .filter(([, entry]) => entry.publicModel === publicModelId)
    .map(([tier]) => tier);

  if (matches.length === 0) {
    return "MEDIUM";
  }

  return matches.reduce((highest, tier) => (TIER_ORDER[tier] > TIER_ORDER[highest] ? tier : highest));
}

function getTraceReason(selected: SelectedModel, failed: boolean): TraceReason {
  if (selected.explicit) return "user";
  if (selected.decision?.tier === "REASONING") return "reasoning";
  if (failed) return "error";
  return "first-pass";
}

function buildPublicHeaders(
  cfg: RouterConfig,
  selected: SelectedModel,
  finalTier: Tier,
  trace: string,
): Record<string, string> {
  return {
    "x-xiaoyi-router-model": selected.routedModel,
    "x-xiaoyi-router-actual-model": selected.actualModel,
    "x-xiaoyi-router-tier": finalTier,
    "x-xiaoyi-router-trace": trace,
    "x-xiaoyi-router-routed": String(selected.routed),
    "x-xiaoyi-router-fallback": "false",
    "x-xiaoyi-router-upstream": cfg.baseUrl,
  };
}

function emitProxyTrace(
  cfg: RouterConfig,
  selected: SelectedModel,
  finalTier: Tier,
  attempts: TraceAttempt[],
  sessionAction: TraceSessionAction,
  failed: boolean,
): string {
  const writer = resolveTraceWriter(cfg.traceLogger);
  const reason = getTraceReason(selected, failed);
  const trace = buildTraceSummary({
    requestedModel: selected.requestedModel,
    routedModel: selected.routedModel,
    actualModel: selected.actualModel,
    tier: finalTier,
    profile: selected.decision?.profile ?? "default",
    reason,
    routed: selected.routed,
    explicit: selected.explicit,
    fallback: false,
  });
  const detail: RouteTraceLog = {
    trace,
    requestedModel: selected.requestedModel,
    routedModel: selected.routedModel,
    actualModel: selected.actualModel,
    tier: finalTier,
    profile: selected.decision?.profile ?? "default",
    reason,
    explicit: selected.explicit,
    routed: selected.routed,
    fallback: false,
    attempts,
    sessionAction,
    ...(selected.decision && {
      method: selected.decision.method,
      confidence: selected.decision.confidence,
      ...(selected.decision.score !== undefined && { score: selected.decision.score }),
      ...(selected.decision.agenticScore !== undefined && {
        agenticScore: selected.decision.agenticScore,
      }),
    }),
    ...(cfg.traceMode === "debug" && { promptPreview: getPromptPreview(selected.routeText) }),
  };

  emitRouteTrace(cfg.traceMode, detail, writer);
  return trace;
}

function chooseModel(
  requestedModel: string,
  body: { messages?: unknown[]; tools?: unknown[] },
  headers: IncomingMessage["headers"],
  sessionStore: SessionStore,
  cfg: RouterConfig,
  tierEntries: Record<Tier, TierEntry>,
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
  routerOptions: RouterOptions,
): SelectedModel {
  const prompt = extractPrompt(body.messages ?? []);

  if (requestedModel !== "auto") {
    const physicalModel = resolvePublicModelCandidate(requestedModel, publicModels, registry);
    return {
      routedModel: requestedModel,
      actualModel: physicalModel.id,
      tier: getExplicitTier(requestedModel, tierEntries),
      routeText: prompt.routeText,
      requestedModel,
      routed: false,
      explicit: true,
      sessionAction: "none",
    };
  }

  const sessionId = deriveSessionId(headers, body.messages ?? []);
  const existing = cfg.sessionPinning ? sessionStore.getSession(sessionId) : undefined;
  const decision = route(
    prompt.routeText,
    prompt.system,
    getMaxOutputTokens(body as Record<string, unknown>),
    routerOptions,
  );
  const routedModel = decision.publicModel;
  const physicalModel = resolvePublicModelCandidate(routedModel, publicModels, registry);

  if (existing && isLowerTier(decision.tier, existing.pinnedTier)) {
    sessionStore.touchSession(sessionId);
    return {
      routedModel: existing.routedPublicModel,
      actualModel: existing.physicalModelId,
      tier: existing.pinnedTier,
      routeText: prompt.routeText,
      requestedModel,
      sessionId,
      routed: true,
      explicit: false,
      sessionAction: "reuse",
    };
  }

  return {
    routedModel,
    actualModel: physicalModel.id,
    tier: decision.tier,
    decision,
    routeText: prompt.routeText,
    requestedModel,
    sessionId,
    routed: true,
    explicit: false,
    sessionAction: "none",
  };
}

// ---------------------------------------------------------------------------
// Chat completion proxy
// ---------------------------------------------------------------------------

async function proxyChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: RouterConfig,
  sessionStore: SessionStore,
  tierEntries: Record<Tier, TierEntry>,
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
  routerOptions: RouterOptions,
): Promise<void> {
  // Read body
  const rawBody = await readBody(req);

  // Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    writeOpenAiError(res, 400, "Invalid JSON body");
    return;
  }

  if (!body || typeof body !== "object") {
    writeOpenAiError(res, 400, "Body must be a JSON object");
    return;
  }

  const bodyObj = body as Record<string, unknown>;

  // Validate model - check if it exists in publicModels
  const requestedModelId = bodyObj.model;
  if (typeof requestedModelId !== "string" || !publicModels[requestedModelId]) {
    const supportedModels = Object.keys(publicModels).sort().join(", ");
    writeOpenAiError(
      res,
      400,
      `Unknown model "${String(requestedModelId)}". Supported models: ${supportedModels}`,
      "invalid_request_error",
      "model_not_found",
    );
    return;
  }

  // Choose the actual upstream model
  const selected = chooseModel(
    requestedModelId,
    bodyObj as { messages?: unknown[]; tools?: unknown[] },
    req.headers,
    sessionStore,
    cfg,
    tierEntries,
    publicModels,
    registry,
    routerOptions,
  );

  const physicalModel = registry.get(selected.actualModel);
  if (!physicalModel) {
    writeOpenAiError(
      res,
      500,
      `Physical model not found in registry: ${selected.actualModel}`,
    );
    return;
  }

  const attempt = await fetchUpstream(cfg, req, bodyObj, physicalModel.id);
  const attempts: TraceAttempt[] = [
    attempt.ok
      ? { model: selected.actualModel, status: "success" }
      : {
          model: selected.actualModel,
          status: "error",
          error: attempt.reason === "network_error"
            ? "network_error"
            : `upstream_http_${attempt.response.status}`,
        },
  ];
  const finalTier = selected.tier;
  let sessionAction = selected.sessionAction;

  if (!attempt.ok && attempt.reason === "network_error") {
    const trace = emitProxyTrace(
      cfg,
      selected,
      finalTier,
      attempts,
      sessionAction,
      true,
    );
    const headers = buildPublicHeaders(cfg, selected, finalTier, trace);
    writeOpenAiError(
      res,
      502,
      attempt.error instanceof Error ? attempt.error.message : "Upstream request failed",
      "invalid_request_error",
      null,
      headers,
    );
    return;
  }

  if (attempt.ok && selected.sessionId && !selected.explicit) {
    sessionStore.setSession(
      selected.sessionId,
      {
        physicalModelId: selected.actualModel,
        routedPublicModel: selected.routedModel,
        pinnedTier: finalTier,
      },
    );
    if (sessionAction === "none") {
      sessionAction = "set";
    }
  }

  const trace = emitProxyTrace(
    cfg,
    selected,
    finalTier,
    attempts,
    sessionAction,
    !attempt.ok,
  );
  const headers = buildPublicHeaders(cfg, selected, finalTier, trace);
  const responseHeaders = copyResponseHeaders(attempt.response, headers);
  res.statusCode = attempt.response.status;
  for (const [k, v] of Object.entries(responseHeaders)) {
    res.setHeader(k, v);
  }
  await streamResponse(attempt.response, res);
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const cfg = resolveConfig({
    baseUrl: options.config.proxy.upstreamUrl,
    apiKey: options.config.proxy.apiKey,
    headers: options.config.proxy.headers,
    port: options.config.proxy.port,
    traceMode: options.config.proxy.trace,
    traceLogger: options.traceLogger,
    sessionPinning: options.session?.enabled,
  });
  const sessionStore = new SessionStore(options.session);
  const publicModels = options.config.publicModels;
  const tierEntries = options.config.routing.tiers;
  const registry = createModelRegistry(options.config.models);
  const routerOptions = buildRouterOptions({
    routingConfig: buildRoutingConfigFromRawConfig(options.config),
    modelPricing: buildModelPricingFromPublicModels(publicModels, registry),
  });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? "/";

        if (req.method === "GET" && url === "/health") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ status: "ok", baseUrl: cfg.baseUrl, version: VERSION }));
          return;
        }

        if (req.method === "POST" && url === "/v1/chat/completions") {
          await proxyChat(req, res, cfg, sessionStore, tierEntries, publicModels, registry, routerOptions);
          return;
        }

        // Everything else → 404
        writeOpenAiError(res, 404, "Not Found");
      } catch (error) {
        if (!res.headersSent) {
          writeOpenAiError(res, 502, String(error));
        } else {
          res.destroy();
        }
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine server port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    baseUrl: cfg.baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          sessionStore.close();
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
