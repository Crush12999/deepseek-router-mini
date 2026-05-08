import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouterConfig, RouterConfigInput } from "./config.js";
import { resolveConfig } from "./config.js";
import type { RealModelId, SupportedModelId } from "./models.js";
import { validateModelId } from "./models.js";
import type { RouteInput } from "./router/types.js";
import { selectModel } from "./router/selector.js";
import { deriveSessionId, SessionPinStore } from "./session.js";

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
  system?: string;
  openingText: string;
};

function extractPrompt(messages: unknown[]): ExtractedPrompt {
  const parts: string[] = [];
  let system: string | undefined;
  let openingText = "";

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
      if (!openingText && text.trim()) {
        openingText = text;
      }
    }
  }

  return { text: parts.join(" "), system, openingText };
}

// ---------------------------------------------------------------------------
// Upstream headers
// ---------------------------------------------------------------------------

function buildUpstreamHeaders(req: IncomingMessage, cfg: RouterConfig): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  // Custom headers override request headers
  Object.assign(headers, cfg.headers);

  // Add auth if missing (header names are case-insensitive per HTTP spec)
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (!hasAuth && cfg.apiKey) {
    headers.authorization = `Bearer ${cfg.apiKey}`;
  }

  // Ensure content-type is set
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
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

function copyResponseHeaders(response: Response, extraHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-deepseek-router-")) continue;
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
  | { ok: false; response: Response }
  | { ok: false; error: unknown };

async function fetchUpstream(
  cfg: ReturnType<typeof resolveConfig>,
  req: IncomingMessage,
  body: Record<string, unknown>,
  model: RealModelId,
): Promise<AttemptResult> {
  try {
    const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: buildUpstreamHeaders(req, cfg),
      body: JSON.stringify({ ...body, model }),
    });

    if (RETRYABLE_STATUS.has(response.status)) {
      return { ok: false, response };
    }

    return { ok: true, response };
  } catch (error) {
    return { ok: false, error };
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

function chooseModel(
  requestedModel: SupportedModelId,
  body: { messages?: unknown[]; tools?: unknown[] },
  req: IncomingMessage,
  pins: SessionPinStore,
  cfg: RouterConfig,
): { model: RealModelId; routed: boolean; sessionId?: string } {
  const prompt = extractPrompt(body.messages ?? []);
  const sessionId = deriveSessionId(req.headers, prompt.openingText);

  if (requestedModel !== "auto") {
    return { model: requestedModel as RealModelId, routed: false, sessionId };
  }

  // Session pinning
  if (cfg.sessionPinning) {
    const pinned = pins.get(sessionId);
    if (pinned) {
      return { model: pinned, routed: true, sessionId };
    }
  }

  // Route decision
  const input: RouteInput = {
    prompt: prompt.text,
    systemPrompt: prompt.system,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    estimatedInputChars: prompt.text.length + (prompt.system?.length ?? 0),
  };

  const decision = selectModel(input);
  return { model: decision.model, routed: true, sessionId };
}

// ---------------------------------------------------------------------------
// Chat completion proxy
// ---------------------------------------------------------------------------

async function proxyChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: RouterConfig,
  pins: SessionPinStore,
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
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
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
    req,
    pins,
    cfg,
  );

  // Observe "auto" requests for session pinning (before fetch)
  if (validation.model === "auto" && selected.sessionId) {
    pins.observe(selected.sessionId, selected.model);
  }

  // Fetch upstream with fallback from Flash to Pro
  let actualModel = selected.model;
  let fallback = false;
  let attempt = await fetchUpstream(cfg, req, bodyObj, selected.model);

  if (!attempt.ok && selected.model === "deepseek-v4-flash") {
    if ("response" in attempt) {
      await discardBody(attempt.response);
    }
    actualModel = "deepseek-v4-pro";
    fallback = true;
    attempt = await fetchUpstream(cfg, req, bodyObj, actualModel);
    if (validation.model === "auto") {
      pins.observe(selected.sessionId, actualModel);
    }
  }

  const headers: Record<string, string> = {
    "x-deepseek-router-model": actualModel,
    "x-deepseek-router-routed": String(selected.routed),
    "x-deepseek-router-fallback": String(fallback),
  };

  if (!attempt.ok && "error" in attempt) {
    writeJson(res, 502, {
      error: attempt.error instanceof Error ? attempt.error.message : "DeepSeek upstream failed",
    });
    return;
  }

  const responseHeaders = copyResponseHeaders(attempt.response, headers);
  res.writeHead(attempt.response.status, responseHeaders);
  await streamResponse(attempt.response, res);
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

export async function startProxy(options: ProxyOptions = {}): Promise<ProxyHandle> {
  const cfg = resolveConfig(options);
  const pins = new SessionPinStore({ enabled: cfg.sessionPinning });

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
          await proxyChat(req, res, cfg, pins);
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
