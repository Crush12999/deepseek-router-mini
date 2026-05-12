import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouterConfig, RouterConfigInput } from "./config.js";
import { resolveConfig } from "./config.js";
import type { RealModelId, SupportedModelId } from "./models.js";
import { MODEL_ROLES, getModelPricing, validateModelId } from "./models.js";
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
  TraceAttempt,
  TraceReason,
  TraceSessionAction,
} from "./router/index.js";
import type { RouterOptions, RoutingDecision, Tier } from "./router/types.js";
import { deriveSessionId, SessionStore } from "./session.js";

export const VERSION = "0.1.0";

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

export type ProxyOptions = RouterConfigInput;

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
  model: RealModelId,
): Promise<AttemptResult> {
  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildUpstreamHeaders(req, cfg),
      body: JSON.stringify({ ...body, model }),
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
  model: RealModelId;
  tier: Tier;
  decision?: RoutingDecision;
  routeText: string;
  requestedModel: SupportedModelId;
  sessionId?: string;
  routed: boolean;
  userExplicit: boolean;
  explicit: boolean;
  sessionAction: TraceSessionAction;
};

function buildModelPricing(): Map<string, ModelPricing> {
  return new Map(
    [MODEL_ROLES.light, MODEL_ROLES.strong].map((modelId) => [
      modelId,
      getModelPricing(modelId),
    ]),
  );
}

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

function buildRouterOptions(hasTools: boolean): RouterOptions {
  return {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing: buildModelPricing(),
    hasTools,
  };
}

function toRealModelId(model: string): RealModelId {
  if (model === MODEL_ROLES.light || model === MODEL_ROLES.strong) {
    return model;
  }

  return MODEL_ROLES.strong;
}

function getExplicitTier(model: RealModelId): Tier {
  return model === MODEL_ROLES.strong ? "COMPLEX" : "MEDIUM";
}

function isReusableSessionPinModel(model: RealModelId): boolean {
  return model !== MODEL_ROLES.light;
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
  actualModel: RealModelId,
  finalTier: Tier,
  trace: string,
): Record<string, string> {
  return {
    "x-xiaoyi-router-model": actualModel,
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
  actualModel: RealModelId,
  finalTier: Tier,
  attempts: TraceAttempt[],
  sessionAction: TraceSessionAction,
  failed: boolean,
): string {
  const writer = resolveTraceWriter(cfg.traceLogger);
  const reason = getTraceReason(selected, failed);
  const trace = buildTraceSummary({
    requestedModel: selected.requestedModel,
    actualModel,
    tier: finalTier,
    profile: selected.decision?.profile,
    reason,
    routed: selected.routed,
    explicit: selected.explicit,
    fallback: false,
  });
  const detail: RouteTraceLog = {
    trace,
    requestedModel: selected.requestedModel,
    actualModel,
    tier: finalTier,
    profile: selected.decision?.profile,
    method: selected.decision?.method,
    confidence: selected.decision?.confidence,
    score: selected.decision?.score,
    agenticScore: selected.decision?.agenticScore,
    routed: selected.routed,
    fallback: false,
    attempts,
    sessionAction,
    ...(cfg.traceMode === "debug" && { promptPreview: getPromptPreview(selected.routeText) }),
  };

  emitRouteTrace(cfg.traceMode, detail, writer);
  return trace;
}

function chooseModel(
  requestedModel: SupportedModelId,
  body: { messages?: unknown[]; tools?: unknown[] },
  headers: IncomingMessage["headers"],
  sessionStore: SessionStore,
  cfg: RouterConfig,
): SelectedModel {
  const prompt = extractPrompt(body.messages ?? []);
  const sessionId = deriveSessionId(headers, body.messages ?? []);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (requestedModel !== "auto") {
    const model = requestedModel as RealModelId;
    const tier = getExplicitTier(model);
    return {
      model,
      tier,
      routeText: prompt.routeText,
      requestedModel,
      sessionId,
      routed: false,
      userExplicit: true,
      explicit: true,
      sessionAction: "none",
    };
  }

  const existing = cfg.sessionPinning ? sessionStore.getSession(sessionId) : undefined;

  if (existing && isReusableSessionPinModel(existing.model)) {
    sessionStore.touchSession(sessionId);
    return {
      model: existing.model,
      tier: existing.tier,
      routeText: prompt.routeText,
      requestedModel,
      sessionId,
      routed: true,
      userExplicit: existing.userExplicit,
      explicit: false,
      sessionAction: "reuse",
    };
  }

  const decision = route(
    prompt.routeText,
    prompt.system,
    getMaxOutputTokens(body as Record<string, unknown>),
    buildRouterOptions(hasTools),
  );
  const model = toRealModelId(decision.model);

  return {
    model,
    tier: decision.tier,
    decision,
    routeText: prompt.routeText,
    requestedModel,
    sessionId,
    routed: true,
    userExplicit: false,
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
): Promise<void> {
  // Read body
  const rawBody = await readBody(req);

  // Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  if (!body || typeof body !== "object") {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Body must be a JSON object" }));
    return;
  }

  const bodyObj = body as Record<string, unknown>;

  // Validate model
  const validation = validateModelId(bodyObj.model);
  if (!validation.ok) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: validation.message }));
    return;
  }

  // Choose the actual upstream model
  const selected = chooseModel(
    validation.model,
    bodyObj as { messages?: unknown[]; tools?: unknown[] },
    req.headers,
    sessionStore,
    cfg,
  );

  const actualModel = selected.model;
  const attempt = await fetchUpstream(cfg, req, bodyObj, actualModel);
  const attempts: TraceAttempt[] = [
    attempt.ok
      ? { model: actualModel, result: "ok", status: attempt.response.status }
      : attempt.reason === "retryable"
        ? { model: actualModel, result: "retryable", status: attempt.response.status }
        : { model: actualModel, result: "network_error" },
  ];
  const finalTier = selected.tier;
  let sessionAction = selected.sessionAction;

  if (!attempt.ok && attempt.reason === "network_error") {
    const trace = emitProxyTrace(
      cfg,
      selected,
      actualModel,
      finalTier,
      attempts,
      sessionAction,
      true,
    );
    const headers = buildPublicHeaders(cfg, selected, actualModel, finalTier, trace);
    writeJsonWithHeaders(
      res,
      502,
      {
        error: attempt.error instanceof Error ? attempt.error.message : "Upstream request failed",
      },
      headers,
    );
    return;
  }

  if (attempt.ok && selected.sessionId && !selected.explicit && isReusableSessionPinModel(actualModel)) {
    sessionStore.setSession(
      selected.sessionId,
      actualModel,
      finalTier,
      selected.userExplicit,
    );
    if (sessionAction === "none") {
      sessionAction = "set";
    }
  }

    const trace = emitProxyTrace(
    cfg,
    selected,
    actualModel,
    finalTier,
    attempts,
    sessionAction,
    !attempt.ok,
  );
  const headers = buildPublicHeaders(cfg, selected, actualModel, finalTier, trace);
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

export async function startProxy(options: ProxyOptions = {}): Promise<ProxyHandle> {
  const cfg = resolveConfig(options);
  const sessionStore = new SessionStore({ enabled: cfg.sessionPinning });

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
          await proxyChat(req, res, cfg, sessionStore);
          return;
        }

        // Everything else → 404
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Not Found" }));
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Bad Gateway", detail: String(error) }));
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
