import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouterConfig, RouterConfigInput } from "./config.js";
import { resolveConfig } from "./config.js";
import type { RealModelId, SupportedModelId } from "./models.js";
import { MODEL_ROLES, getModelPricing, validateModelId } from "./models.js";
import { DEFAULT_ROUTING_CONFIG, getFallbackChain, route } from "./router/index.js";
import type { ModelPricing } from "./router/index.js";
import type { RouterOptions, RoutingDecision, Tier, TierConfig } from "./router/types.js";
import { deriveSessionId, hashRequestContent, SessionStore } from "./session.js";

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
const TIER_ORDER: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];

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

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort cleanup before trying the fallback model.
  }
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

type SelectedModel = {
  model: RealModelId;
  tier: Tier;
  decision?: RoutingDecision;
  fallbackChain: RealModelId[];
  sessionId?: string;
  routed: boolean;
  userExplicit: boolean;
  explicit: boolean;
  tierConfigs: Record<Tier, TierConfig>;
};

function buildModelPricing(): Map<string, ModelPricing> {
  return new Map(
    [MODEL_ROLES.light, MODEL_ROLES.strong].map((modelId) => [
      modelId,
      getModelPricing(modelId),
    ]),
  );
}

function extractToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") return undefined;
      const record = tool as Record<string, unknown>;
      const fn = record.function;
      if (fn && typeof fn === "object") {
        const name = (fn as Record<string, unknown>).name;
        if (typeof name === "string") return name;
      }
      const name = record.name;
      return typeof name === "string" ? name : undefined;
    })
    .filter((name): name is string => Boolean(name));
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

function toRealFallbackChain(models: string[], selectedModel: RealModelId): RealModelId[] {
  const chain = models.map(toRealModelId);
  if (!chain.includes(selectedModel)) {
    chain.unshift(selectedModel);
  }

  return [...new Set(chain)];
}

function getExplicitTier(model: RealModelId): Tier {
  return model === MODEL_ROLES.strong ? "COMPLEX" : "MEDIUM";
}

function getExplicitFallbackChain(model: RealModelId): RealModelId[] {
  return model === MODEL_ROLES.light ? [MODEL_ROLES.light, MODEL_ROLES.strong] : [MODEL_ROLES.strong];
}

function getActualTier(
  model: RealModelId,
  selected: Pick<SelectedModel, "model" | "tier" | "tierConfigs">,
): Tier {
  if (model === selected.model) return selected.tier;

  const selectedIndex = TIER_ORDER.indexOf(selected.tier);
  for (const tier of TIER_ORDER.slice(Math.max(0, selectedIndex + 1))) {
    if (selected.tierConfigs[tier]?.primary === model) {
      return tier;
    }
  }

  for (const tier of TIER_ORDER) {
    if (selected.tierConfigs[tier]?.primary === model) {
      return tier;
    }
  }

  return selected.tier;
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
  const toolNames = extractToolNames(body.tools);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (requestedModel !== "auto") {
    const model = requestedModel as RealModelId;
    const tier = getExplicitTier(model);
    sessionStore.setSession(sessionId, model, tier, true);
    return {
      model,
      tier,
      fallbackChain: getExplicitFallbackChain(model),
      sessionId,
      routed: false,
      userExplicit: true,
      explicit: true,
      tierConfigs: DEFAULT_ROUTING_CONFIG.tiers,
    };
  }

  const requestHash = sessionId ? hashRequestContent(prompt.routeText, toolNames) : undefined;
  const existing = cfg.sessionPinning ? sessionStore.getSession(sessionId) : undefined;

  if (existing) {
    const shouldEscalate = requestHash ? sessionStore.recordRequestHash(sessionId, requestHash) : false;
    const escalated = shouldEscalate
      ? sessionStore.escalateSession(sessionId, DEFAULT_ROUTING_CONFIG.tiers)
      : undefined;
    const entry = sessionStore.getSession(sessionId) ?? existing;
    const model = escalated?.model ?? entry.model;
    const tier = escalated?.tier ?? entry.tier;
    const chain = model === MODEL_ROLES.light
      ? toRealFallbackChain(getFallbackChain(tier, DEFAULT_ROUTING_CONFIG.tiers), model)
      : [model];

    if (!requestHash) {
      sessionStore.touchSession(sessionId);
    }

    return {
      model,
      tier,
      fallbackChain: chain,
      sessionId,
      routed: true,
      userExplicit: entry.userExplicit,
      explicit: false,
      tierConfigs: DEFAULT_ROUTING_CONFIG.tiers,
    };
  }

  const decision = route(
    prompt.routeText,
    prompt.system,
    getMaxOutputTokens(body as Record<string, unknown>),
    buildRouterOptions(hasTools),
  );
  const model = toRealModelId(decision.model);
  const tierConfigs = decision.tierConfigs ?? DEFAULT_ROUTING_CONFIG.tiers;
  const fallbackChain = toRealFallbackChain(getFallbackChain(decision.tier, tierConfigs), model);

  sessionStore.setSession(sessionId, model, decision.tier, false);
  if (requestHash) {
    sessionStore.recordRequestHash(sessionId, requestHash);
  }

  return {
    model,
    tier: decision.tier,
    decision,
    fallbackChain,
    sessionId,
    routed: true,
    userExplicit: false,
    explicit: false,
    tierConfigs,
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

  let actualModel = selected.model;
  let fallback = false;
  let attempt: AttemptResult | undefined;

  for (const [index, model] of selected.fallbackChain.entries()) {
    actualModel = model;
    fallback = index > 0;
    attempt = await fetchUpstream(cfg, req, bodyObj, model);

    if (attempt.ok) {
      break;
    }

    const hasNext = index < selected.fallbackChain.length - 1;
    if (!hasNext) {
      break;
    }

    if (attempt.reason === "retryable") {
      await discardBody(attempt.response);
    }
  }

  if (!attempt) {
    const headers: Record<string, string> = {
      "x-xiaoyi-router-model": actualModel,
      "x-xiaoyi-router-routed": String(selected.routed),
      "x-xiaoyi-router-fallback": String(fallback),
      "x-xiaoyi-router-upstream": cfg.baseUrl,
    };
    writeJsonWithHeaders(res, 502, { error: "Upstream request failed" }, headers);
    return;
  }

  const headers: Record<string, string> = {
    "x-xiaoyi-router-model": actualModel,
    "x-xiaoyi-router-routed": String(selected.routed),
    "x-xiaoyi-router-fallback": String(fallback),
    "x-xiaoyi-router-upstream": cfg.baseUrl,
  };

  if (!attempt.ok && attempt.reason === "network_error") {
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

  if (attempt.ok && selected.sessionId && actualModel !== selected.model) {
    sessionStore.setSession(
      selected.sessionId,
      actualModel,
      getActualTier(actualModel, selected),
      selected.userExplicit,
    );
  }

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
