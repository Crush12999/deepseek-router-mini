import { DEFAULT_BASE_URL, DEFAULT_PORT } from "./config.js";
import { startProxy as startProxyImpl } from "./proxy.js";
import type { ProxyHandle, ProxyOptions } from "./proxy.js";
import {
  DEEPSEEK_OPENCLAW_MODELS,
  DEEPSEEK_PROVIDER_API,
  DEEPSEEK_PROVIDER_ID,
  createDeepSeekProvider,
} from "./provider.js";
import type { DeepSeekProvider } from "./provider.js";

type JsonObject = Record<string, unknown>;

export type OpenClawService = {
  id: "deepseek-router-proxy";
  stop: () => Promise<void>;
};

export type OpenClawPluginApi = {
  config: JsonObject;
  registerProvider: (provider: DeepSeekProvider) => void;
  registerService: (service: OpenClawService) => void;
  logger?: {
    info?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type OpenClawPlugin = {
  id: "deepseek-router-mini";
  name: "DeepSeek Router Mini";
  description: "DeepSeek-only local routing proxy for OpenClaw";
  version: string;
  register: (api: OpenClawPluginApi) => Promise<void>;
};

export type PluginRuntime = {
  startProxy: (options: ProxyOptions) => Promise<ProxyHandle>;
};

const defaultRuntime: PluginRuntime = {
  startProxy: startProxyImpl,
};

let activeProxy: ProxyHandle | undefined;

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  return value as JsonObject;
}

export function localProviderBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

export function injectDeepSeekModelsConfig(config: JsonObject, providerBaseUrl: string): void {
  const models = ensureObject(config, "models");
  const providers = ensureObject(models, "providers");
  const current = providers[DEEPSEEK_PROVIDER_ID];
  const existing =
    current && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};

  providers[DEEPSEEK_PROVIDER_ID] = {
    ...existing,
    baseUrl: providerBaseUrl,
    api: DEEPSEEK_PROVIDER_API,
    apiKey: existing.apiKey,
    models: DEEPSEEK_OPENCLAW_MODELS,
  };
}

function parsePluginPort(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return DEFAULT_PORT;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return DEFAULT_PORT;
  return port;
}

async function stopActiveProxy(): Promise<void> {
  const proxy = activeProxy;
  activeProxy = undefined;
  if (proxy) {
    await proxy.close();
  }
}

export async function registerOpenClawPlugin(
  api: OpenClawPluginApi,
  runtime: PluginRuntime = defaultRuntime,
): Promise<void> {
  const port = parsePluginPort(process.env.DEEPSEEK_ROUTER_PORT);
  const upstreamUrl = process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const providerBaseUrl = localProviderBaseUrl(port);

  api.registerProvider(createDeepSeekProvider(providerBaseUrl));
  injectDeepSeekModelsConfig(api.config, providerBaseUrl);

  try {
    activeProxy = await runtime.startProxy({ port, baseUrl: upstreamUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger?.error?.(`DeepSeek Router Mini failed to start on port ${port}: ${message}`);
    throw error;
  }

  api.registerService({
    id: "deepseek-router-proxy",
    stop: stopActiveProxy,
  });

  api.logger?.info?.(`DeepSeek Router Mini listening on ${providerBaseUrl}`);
}
