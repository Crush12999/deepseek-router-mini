import { normalizeTraceMode } from "./router/index.js";
import type { TraceLogger, TraceMode } from "./router/index.js";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_PORT = 8402;

export type RouterConfig = {
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  port: number;
  sessionPinning: boolean;
  traceMode: TraceMode;
  traceLogger?: TraceLogger;
};

export type RouterConfigInput = Partial<RouterConfig>;

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Pure config resolver — all values come from the caller, no process.env.
 */
export function resolveConfig(input: RouterConfigInput = {}): RouterConfig {
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL),
    apiKey: input.apiKey,
    headers: input.headers ?? {},
    port: input.port ?? DEFAULT_PORT,
    sessionPinning: input.sessionPinning ?? true,
    traceMode: normalizeTraceMode(input.traceMode),
    traceLogger: input.traceLogger,
  };
}
