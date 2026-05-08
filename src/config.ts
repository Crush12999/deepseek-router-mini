import type { SupportedModelId } from "./models.js";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_PORT = 8402;

export type RouterConfig = {
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  port: number;
  defaultModel: SupportedModelId;
  sessionPinning: boolean;
};

export type RouterConfigInput = Partial<RouterConfig>;

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parsePort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
  return port;
}

export function parseHeaderJson(value: string | undefined): Record<string, string> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }

    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue !== "string") {
        throw new Error(`header ${key} must be a string`);
      }
      headers[key] = headerValue;
    }
    return headers;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid DEEPSEEK_ROUTER_HEADERS")) {
      throw error;
    }
    throw new Error(
      `Invalid DEEPSEEK_ROUTER_HEADERS: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function resolveConfig(input: RouterConfigInput = {}): RouterConfig {
  const envHeaders = parseHeaderJson(process.env.DEEPSEEK_ROUTER_HEADERS);

  return {
    baseUrl: normalizeBaseUrl(input.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL),
    apiKey: input.apiKey ?? process.env.DEEPSEEK_API_KEY,
    headers: { ...envHeaders, ...(input.headers ?? {}) },
    port: input.port ?? parsePort(process.env.DEEPSEEK_ROUTER_PORT) ?? DEFAULT_PORT,
    defaultModel: input.defaultModel ?? "auto",
    sessionPinning: input.sessionPinning ?? true,
  };
}
