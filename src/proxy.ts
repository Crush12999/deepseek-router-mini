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

export const VERSION = "1.0.2";

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
/**
 * 运行时韧性保护默认值。
 *
 * 这里统一集中定义，方便 CLI / 测试 / 未来配置入口共享同一组基线。
 */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 300_000;

/**
 * `startProxy()` 实际运行时使用的完整限制集合。
 *
 * 这里把每个限制都解析成必填字段，避免请求处理路径再去分支判断默认值。
 */
export type ProxyRuntimeLimits = {
  /**
   * 允许单个客户端请求体占用的最大 UTF-8 字节数。
   */
  maxBodyBytes: number;
  /**
   * 允许客户端在请求体读取阶段占用连接的最长时间。
   */
  bodyReadTimeoutMs: number;
  /**
   * 单次上游请求允许占用的最长时间。
   *
   * 超时后 proxy 会主动 abort 当前 fetch，并把它转换成面向客户端的 504。
   */
  upstreamRequestTimeoutMs: number;
};

/**
 * 调用方可按需覆盖的运行时限制输入。
 */
export type ProxyRuntimeLimitInput = Partial<ProxyRuntimeLimits>;

/**
 * Proxy 在未显式传参时采用的默认运行时限制。
 */
export const DEFAULT_RUNTIME_LIMITS: ProxyRuntimeLimits = {
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  bodyReadTimeoutMs: DEFAULT_BODY_READ_TIMEOUT_MS,
  upstreamRequestTimeoutMs: DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
};

/**
 * 归一化运行时限制输入，确保请求处理路径拿到的是完整、稳定的配置对象。
 */
export function resolveRuntimeLimits(
  input?: ProxyRuntimeLimitInput,
): ProxyRuntimeLimits {
  return {
    maxBodyBytes: input?.maxBodyBytes ?? DEFAULT_RUNTIME_LIMITS.maxBodyBytes,
    bodyReadTimeoutMs:
      input?.bodyReadTimeoutMs ?? DEFAULT_RUNTIME_LIMITS.bodyReadTimeoutMs,
    upstreamRequestTimeoutMs:
      input?.upstreamRequestTimeoutMs ??
      DEFAULT_RUNTIME_LIMITS.upstreamRequestTimeoutMs,
  };
}

/**
 * 当前版本对外暴露的可请求 model 白名单。
 *
 * `publicModels` 仍然可以包含 `flash` / `pro` / `lite` / `think` 等 alias，
 * 但它们只作为 Router 内部语义输出，不接受客户端显式请求。
 */
const REQUESTABLE_PUBLIC_MODELS = new Set(["auto"]);
const PUBLIC_HEADER_PREFIXES = ["x-xy-router-"] as const;

/**
 * 启动本地 HTTP proxy 所需的全部输入。
 */
export type ProxyOptions = {
  config: RawConfig;
  traceLogger?: TraceLogger;
  session?: Partial<SessionConfig>;
  runtimeLimits?: ProxyRuntimeLimitInput;
};

/**
 * 已启动 proxy 的可关闭句柄。
 */
export type ProxyHandle = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 请求体读取阶段使用的结构化错误。
 *
 * 它把“HTTP 应返回什么状态码”与“内部异常控制流”绑定在一起，方便边界层统一
 * 转换成 OpenAI-compatible 错误响应。
 */
class BodyReadError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "BodyReadError";
    this.statusCode = statusCode;
  }
}

/**
 * 判断未知异常是否来自请求体读取阶段，避免把 413 一类客户端错误误报成 502。
 */
function isBodyReadError(error: unknown): error is BodyReadError {
  return error instanceof BodyReadError;
}

/**
 * 对请求体读取失败返回结构化客户端错误，并在响应刷出后关闭当前连接。
 *
 * 这里不能在 `readBody()` 的超时/超限分支里立刻 `req.destroy()`，否则客户端往往只会
 * 看到底层 `ECONNRESET`，拿不到 OpenAI-compatible JSON 错误。正确顺序是：
 * 1. 先把 408/413 之类的结构化错误写回客户端；
 * 2. 再把这个“请求体尚未完整消费”的连接标记为不可复用；
 * 3. 等响应完成后销毁 request/socket，避免半读状态的连接进入 keep-alive 池。
 */
function writeBodyReadErrorAndCloseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  error: BodyReadError,
): void {
  res.shouldKeepAlive = false;
  res.setHeader("connection", "close");
  res.once("finish", () => {
    if (!req.destroyed) {
      req.destroy();
    }
  });
  writeOpenAiError(res, error.statusCode, error.message);
}

/**
 * 读取完整请求体文本。
 *
 * 同时负责：
 * - `maxBodyBytes`：限制单个请求可读入的总字节数；
 * - `bodyReadTimeoutMs`：限制客户端在“持续占着连接但迟迟不发完 body”时可占用的时间。
 *
 * 超时分支只 reject，不在这里直接 `req.destroy()`。这样外层 `proxyChat()` 仍有机会
 * 返回结构化 408 JSON，而不是让客户端只看到 `ECONNRESET`。
 */
function readBody(
  req: IncomingMessage,
  limits: ProxyRuntimeLimits,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    req.setEncoding("utf8");
    const timeout = setTimeout(() => {
      rejectOnce(new BodyReadError(408, "Request body read timeout"));
    }, limits.bodyReadTimeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (value: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: string): void => {
      if (settled) return;

      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > limits.maxBodyBytes) {
        rejectOnce(new BodyReadError(413, "Payload Too Large"));
        return;
      }

      body += chunk;
    };

    const onEnd = (): void => resolveOnce(body);
    const onError = (error: Error): void => rejectOnce(error);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * 从 OpenAI / OpenClaw 风格消息数组里提取路由真正关心的文本视图。
 *
 * - `text`：非 system 消息拼接后的总文本
 * - `routeText`：用于路由判定的 user 文本；OpenClaw 新格式会在尾部放置
 *   两条连续 user 消息，此时前一条承载真实 query
 * - `system`：system prompt 聚合结果
 * - `openingText`：第一段非空文本，便于未来扩展首轮特征
 */
type ExtractedPrompt = {
  text: string;
  routeText: string;
  system?: string;
  openingText: string;
};

const OPENCLAW_CLI_TURN_PATTERN =
  /(?:^|\n)\[[^\]\n]+?\]\s+([\s\S]*?)(?=(?:\n\[[^\]\n]+?\]\s+)|$)/g;

/**
 * 保留 user 文本原样参与路由。
 *
 * 曾经这里会用 `OPENCLAW_CLI_TURN_PATTERN` 从 OpenClaw CLI transcript 中截取
 * 某一轮文本；该逻辑先保留但停用，便于后续确认是否需要恢复。
 */
function extractRouteTextFromUserMessage(text: string): string {
  // const matches = [...text.matchAll(OPENCLAW_CLI_TURN_PATTERN)];
  // const last = matches.at(-1)?.[1]?.trim();
  // return last || text;
  void OPENCLAW_CLI_TURN_PATTERN;
  return text;
}

/**
 * 从 messages 中抽取 Router 需要的 prompt 视图。
 */
function extractPrompt(messages: unknown[]): ExtractedPrompt {
  const parts: string[] = [];
  let system: string | undefined;
  let openingText = "";
  let routeUserText = "";
  let previousRole: unknown;
  let previousUserText = "";

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
            typeof p === "object" &&
            p !== null &&
            (p as Record<string, unknown>).type === "text",
        )
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join(" ");
    }

    if (role === "system") {
      system = system ? `${system}\n${text}` : text;
    } else {
      parts.push(text);
      if (role === "user" && text.trim()) {
        if (previousRole === "user" && previousUserText.trim()) {
          routeUserText = previousUserText;
        } else {
          routeUserText = extractRouteTextFromUserMessage(text);
        }
      }
      if (!openingText && text.trim()) {
        openingText = text;
      }
    }

    previousRole = role;
    previousUserText =
      role === "user" ? extractRouteTextFromUserMessage(text) : "";
  }

  const text = parts.join(" ");
  return { text, routeText: routeUserText || text, system, openingText };
}

// ---------------------------------------------------------------------------
// Upstream headers
// ---------------------------------------------------------------------------

/**
 * 生成转发到上游的请求头。
 *
 * 优先级：
 * 1. 来自原始请求的非 hop-by-hop header
 * 2. `config.proxy.headers` 覆盖同名 header
 * 3. 若仍无 Authorization，则补上 `config.proxy.apiKey`
 */
function buildUpstreamHeaders(
  req: IncomingMessage,
  cfg: RouterConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};

  const setHeader = (key: string, value: string): void => {
    const existingKey = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
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
  const hasAuth = Object.keys(headers).some(
    (k) => k.toLowerCase() === "authorization",
  );
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

/**
 * 统一写 JSON 响应，且只在 headers 尚未发送时生效。
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}

/**
 * 复制上游响应头，并剔除不应继续透传到客户端的 header。
 *
 * 这里会主动移除任何上游已带的公开路由头，确保最终对外头部完全由当前
 * Router 实例生成。
 */
function copyResponseHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (PUBLIC_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix)))
      continue;
    headers[key] = value;
  }
  Object.assign(headers, extraHeaders);
  return headers;
}

/**
 * 透明转发上游响应体（支持流式 body）。
 */
async function streamResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  if (response.body) {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      res.write(chunk);
    }
  }
  res.end();
}

/**
 * 输出 OpenAI-compatible 错误结构，可选附带路由诊断头。
 */
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

type LinkedAbortSignal = {
  signal: AbortSignal;
  cleanup: () => void;
};

/**
 * 把多个 abort signal 聚合成一个 signal，供单个 `fetch()` 统一消费。
 *
 * 这里显式返回 `cleanup()`，因为上游流式响应在 `fetch()` resolve 之后仍可能继续
 * 读取 body；只有在 proxy 完全结束这次转发后，才能安全移除监听器，避免：
 * 1. 客户端中途断开后无法继续取消上游；
 * 2. 长连接场景中事件监听器残留造成泄漏。
 */
function anySignal(signals: AbortSignal[]): LinkedAbortSignal {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
  };

  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
    cleanup();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      return { signal: controller.signal, cleanup };
    }
  }

  for (const signal of signals) {
    const listener = (): void => {
      abortFrom(signal);
    };
    listeners.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
  }

  return { signal: controller.signal, cleanup };
}

/**
 * 上游请求结果：
 * - `ok: true`：拿到可直接返回的响应
 * - `retryable`：拿到了响应，但状态码属于可重试类
 * - `timeout`：请求已发出，但在限定时间内没等到可用响应
 * - `aborted`：客户端已断开，本次 proxy 不应再继续消耗上游资源或写回响应
 * - `network_error`：压根没拿到 HTTP 响应
 */
type AttemptResult = {
  cleanup: () => void;
} & (
  | { ok: true; response: Response }
  | { ok: false; reason: "retryable"; response: Response }
  | { ok: false; reason: "timeout"; error: unknown }
  | { ok: false; reason: "aborted"; error: unknown }
  | { ok: false; reason: "network_error"; error: unknown }
);

/**
 * 执行一次上游 Chat Completions 调用，并把 public alias 改写成真实 physical
 * model。
 *
 * 这里把“客户端断连”和“上游首包超时”合并到同一个 `fetch()` signal：
 * - 客户端断开：立刻取消上游，避免继续计费/占用流式连接；
 * - 超时：只覆盖等待上游响应头这一段，首包到达后即清除计时器。
 */
async function fetchUpstream(
  cfg: ReturnType<typeof resolveConfig>,
  req: IncomingMessage,
  body: Record<string, unknown>,
  actualModel: string,
  runtimeLimits: ProxyRuntimeLimits,
  requestSignal: AbortSignal,
): Promise<AttemptResult> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timeoutController.abort();
  }, runtimeLimits.upstreamRequestTimeoutMs);
  const linkedSignal = anySignal([requestSignal, timeoutController.signal]);
  const cleanup = (): void => {
    clearTimeout(timeout);
    linkedSignal.cleanup();
  };

  try {
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildUpstreamHeaders(req, cfg),
      body: JSON.stringify({ ...body, model: actualModel }),
      signal: linkedSignal.signal,
    });
    clearTimeout(timeout);

    if (RETRYABLE_STATUS.has(response.status)) {
      return { ok: false, reason: "retryable", response, cleanup };
    }

    return { ok: true, response, cleanup };
  } catch (error) {
    // 若客户端断连与超时几乎同时发生，优先保留 timeout，避免把真实的上游慢响应
    // 误归类成客户端主动取消。
    if (timeoutController.signal.aborted) {
      return { ok: false, reason: "timeout", error, cleanup };
    }

    if (requestSignal.aborted) {
      return { ok: false, reason: "aborted", error, cleanup };
    }

    return { ok: false, reason: "network_error", error, cleanup };
  }
}

/**
 * `chooseModel()` 产出的编排结果。
 *
 * 这份结构专门服务于 `proxyChat()`：它既包含“语义层 alias 决策”，也包含
 * “实际上游 model 选择”和 trace / session 所需的附加上下文。
 */
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

/**
 * 兼容 OpenAI 常见的两个最大输出 token 字段名。
 */
function getMaxOutputTokens(body: Record<string, unknown>): number {
  const maxTokens = body.max_tokens;
  if (
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0
  ) {
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

/**
 * 组装 Router 内核所需的运行时 options。
 */
function buildRouterOptions(options: {
  routingConfig: RoutingConfig;
  modelPricing: Map<string, ModelPricing>;
}): RouterOptions {
  return {
    config: options.routingConfig,
    modelPricing: options.modelPricing,
  };
}

/**
 * 把持久化 RawConfig 映射为 Router 运行时配置。
 */
function buildRoutingConfigFromRawConfig(rawConfig: RawConfig): RoutingConfig {
  const scoring = {
    ...DEFAULT_ROUTING_CONFIG.scoring,
    tierBoundaries: {
      ...DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries,
      ...rawConfig.routing.tierBoundaries,
    },
    confidenceThreshold:
      rawConfig.routing.confidenceThreshold ?? DEFAULT_ROUTING_CONFIG.scoring.confidenceThreshold,
  };

  return {
    ...DEFAULT_ROUTING_CONFIG,
    scoring,
    tiers: mapRawTierEntries(rawConfig.routing.tiers),
    overrides: {
      structuredOutputMinTier:
        rawConfig.routing.structuredOutputMinTier ?? "MEDIUM",
      ambiguousDefaultTier: rawConfig.routing.ambiguousDefaultTier ?? "MEDIUM",
    },
  };
}

/**
 * 将配置文件里的 tier 结构转换成 Router 核心使用的 primary / fallback 结构。
 */
function mapRawTierEntries(
  entries: Record<Tier, TierEntry>,
): Record<Tier, TierConfig> {
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

/**
 * 为 alias 层构造成本表。
 *
 * 注意这里的 key 是 public alias：`auto` 使用自身 metadata 成本，普通 alias
 * 则解析到实际 physical model 后继承其单价。
 */
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

      const physicalModel = resolvePublicModelCandidate(
        publicModelId,
        publicModels,
        registry,
      );
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

/**
 * 会话 pinning 只允许“维持当前 tier 或升级”，不允许降级。
 */
function isLowerTier(nextTier: Tier, pinnedTier: Tier): boolean {
  return TIER_ORDER[nextTier] < TIER_ORDER[pinnedTier];
}

/**
 * 根据 alias 出现在 tier 配置中的位置，反推出一个“显式请求时应显示的 tier”。
 *
 * 虽然当前请求边界只接受 `auto`，但保留这段逻辑能让代码在将来重新开放 alias
 * 请求时仍然自洽，也便于测试 / 内部调用复用。
 */
function getExplicitTier(
  publicModelId: string,
  entries: Record<Tier, TierEntry>,
): Tier {
  const matches = (Object.entries(entries) as Array<[Tier, TierEntry]>)
    .filter(([, entry]) => entry.publicModel === publicModelId)
    .map(([tier]) => tier);

  if (matches.length === 0) {
    return "MEDIUM";
  }

  return matches.reduce((highest, tier) =>
    TIER_ORDER[tier] > TIER_ORDER[highest] ? tier : highest,
  );
}

/**
 * 决定 trace reason 字段，供 summary / debug trace 共用。
 */
function getTraceReason(selected: SelectedModel, failed: boolean): TraceReason {
  if (selected.explicit) return "user";
  if (selected.decision?.tier === "REASONING") return "reasoning";
  if (failed) return "error";
  return "first-pass";
}

/**
 * 构造对客户端公开的路由响应头。
 */
function buildPublicHeaders(
  cfg: RouterConfig,
  selected: SelectedModel,
  finalTier: Tier,
  trace: string,
): Record<string, string> {
  return {
    "x-xy-router-model": selected.routedModel,
    "x-xy-router-actual-model": selected.actualModel,
    "x-xy-router-tier": finalTier,
    "x-xy-router-trace": trace,
    "x-xy-router-routed": String(selected.routed),
    "x-xy-router-fallback": "false",
    "x-xy-router-upstream": cfg.baseUrl,
  };
}

/**
 * 发送一条结构化路由 trace，并返回紧凑 trace 字符串。
 */
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
      ...(selected.decision.score !== undefined && {
        score: selected.decision.score,
      }),
      ...(selected.decision.agenticScore !== undefined && {
        agenticScore: selected.decision.agenticScore,
      }),
    }),
    ...(cfg.traceMode === "debug" && {
      promptPreview: getPromptPreview(selected.routeText),
    }),
  };

  emitRouteTrace(cfg.traceMode, detail, writer);
  return trace;
}

/**
 * 选择本次请求最终应使用的 alias / physical model。
 *
 * 当前外部请求边界已经在 `proxyChat()` 收紧到只允许 `auto`，但这里仍保留了
 * 显式 alias 分支，使该函数在测试、未来协议调整或内部复用时更容易扩展。
 */
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
    // 兼容式分支：如果未来重新允许显式 alias，请求会在这里直接解析到
    // physical model，而不会经过 auto 路由。
    const physicalModel = resolvePublicModelCandidate(
      requestedModel,
      publicModels,
      registry,
    );
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
  const existing = cfg.sessionPinning
    ? sessionStore.getSession(sessionId)
    : undefined;
  const decision = route(
    prompt.routeText,
    prompt.system,
    getMaxOutputTokens(body as Record<string, unknown>),
    routerOptions,
  );
  const routedModel = decision.publicModel;
  const physicalModel = resolvePublicModelCandidate(
    routedModel,
    publicModels,
    registry,
  );

  // 会话已 pin 到更高 tier 时，不允许新的简单请求把它降回来。
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

/**
 * 处理 `POST /v1/chat/completions`。
 *
 * 这是整个仓库最重要的边界函数：它负责请求合法性校验、auto 路由、physical
 * model 解析、上游转发，以及所有对外响应头 / 错误格式的一致性。
 */
async function proxyChat(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: RouterConfig,
  runtimeLimits: ProxyRuntimeLimits,
  sessionStore: SessionStore,
  tierEntries: Record<Tier, TierEntry>,
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
  routerOptions: RouterOptions,
): Promise<void> {
  // Read body
  let rawBody: string;
  try {
    rawBody = await readBody(req, runtimeLimits);
  } catch (error) {
    if (isBodyReadError(error)) {
      writeBodyReadErrorAndCloseRequest(req, res, error);
      return;
    }
    throw error;
  }

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

  const requestedModelId = bodyObj.model;
  const supportedModels = [...REQUESTABLE_PUBLIC_MODELS]
    .filter((modelId) => publicModels[modelId])
    .sort()
    .join(", ");
  if (
    typeof requestedModelId !== "string" ||
    !publicModels[requestedModelId] ||
    !REQUESTABLE_PUBLIC_MODELS.has(requestedModelId)
  ) {
    // 这里故意同时检查：
    // 1. 配置里是否存在该 public model
    // 2. 它是否属于当前“允许被客户端显式请求”的极小白名单
    // 从而把 alias 从“配置驱动内部语义”与“外部请求合同”严格分开。
    writeOpenAiError(
      res,
      400,
      `Unknown model "${String(requestedModelId)}". Supported models: ${supportedModels}`,
      "invalid_request_error",
      "model_not_found",
    );
    return;
  }

  // 先完成 alias 级别决策，再解析实际发往上游的 physical model。
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

  const requestController = new AbortController();
  let responseFinished = false;
  /**
   * 客户端一旦在 proxy 等待/转发上游期间断开，就立刻取消上游请求，避免继续
   * 持有流式连接或产生无意义的上游计费。
   */
  const abortUpstreamRequest = (): void => {
    if (responseFinished || requestController.signal.aborted) return;
    requestController.abort();
  };
  const onRequestAborted = (): void => {
    abortUpstreamRequest();
  };
  const onResponseClose = (): void => {
    abortUpstreamRequest();
  };
  const onResponseFinish = (): void => {
    responseFinished = true;
  };
  const cleanupRequestAbortListeners = (): void => {
    req.off("aborted", onRequestAborted);
    res.off("close", onResponseClose);
    res.off("finish", onResponseFinish);
  };

  req.on("aborted", onRequestAborted);
  res.on("close", onResponseClose);
  res.on("finish", onResponseFinish);

  let attempt: AttemptResult | undefined;
  try {
    attempt = await fetchUpstream(
      cfg,
      req,
      bodyObj,
      physicalModel.id,
      runtimeLimits,
      requestController.signal,
    );
    const attempts: TraceAttempt[] = [
      attempt.ok
        ? { model: selected.actualModel, status: "success" }
        : {
            model: selected.actualModel,
            status: "error",
            error:
              attempt.reason === "timeout"
                ? "upstream_timeout"
                : attempt.reason === "network_error"
                  ? "network_error"
                  : attempt.reason === "aborted"
                    ? "client_aborted"
                    : `upstream_http_${attempt.response.status}`,
          },
    ];
    const finalTier = selected.tier;
    let sessionAction = selected.sessionAction;

    if (!attempt.ok && attempt.reason === "aborted") {
      emitProxyTrace(
        cfg,
        selected,
        finalTier,
        attempts,
        sessionAction,
        true,
      );
      return;
    }

    if (!attempt.ok && attempt.reason === "timeout") {
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
        504,
        "Upstream request timed out",
        "invalid_request_error",
        null,
        headers,
      );
      return;
    }

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
        attempt.error instanceof Error
          ? attempt.error.message
          : "Upstream request failed",
        "invalid_request_error",
        null,
        headers,
      );
      return;
    }

    // 只有真正拿到 HTTP 响应后才更新 session pinning，避免把纯网络错误写成成功 pin。
    if (attempt.ok && selected.sessionId && !selected.explicit) {
      sessionStore.setSession(selected.sessionId, {
        physicalModelId: selected.actualModel,
        routedPublicModel: selected.routedModel,
        pinnedTier: finalTier,
      });
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
    responseFinished = true;
  } finally {
    cleanupRequestAbortListeners();
    attempt?.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

/**
 * 启动本地 Router HTTP 服务。
 */
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
  const runtimeLimits = resolveRuntimeLimits(options.runtimeLimits);
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
          res.end(
            JSON.stringify({
              status: "ok",
              baseUrl: cfg.baseUrl,
              version: VERSION,
            }),
          );
          return;
        }

        // 当前版本只暴露一个业务入口，其他路径统一保持 OpenAI-compatible 404。
        if (req.method === "POST" && url === "/v1/chat/completions") {
          await proxyChat(
            req,
            res,
            cfg,
            runtimeLimits,
            sessionStore,
            tierEntries,
            publicModels,
            registry,
            routerOptions,
          );
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
