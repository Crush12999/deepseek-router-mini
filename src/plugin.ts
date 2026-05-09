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
  start: (ctx?: unknown) => Promise<void>;
  stop: (ctx?: unknown) => Promise<void>;
};

export type OpenClawPluginApi = {
  config: JsonObject;
  pluginConfig?: { port?: unknown; upstreamUrl?: unknown } | Record<string, unknown>;
  registrationMode?: string;
  registerProvider: (provider: DeepSeekProvider) => void;
  registerService: (service: OpenClawService) => void;
  unregisterService?: (id: string) => void | Promise<void>;
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
  register: (api: OpenClawPluginApi) => void;
};

export type PluginRuntime = {
  startProxy: (options: ProxyOptions) => Promise<ProxyHandle>;
};

const defaultRuntime: PluginRuntime = {
  startProxy: startProxyImpl,
};

let activeProxy: ProxyHandle | undefined;
const closedProxies = new WeakSet<ProxyHandle>();
const closingProxies = new WeakMap<ProxyHandle, Promise<void>>();
const RUNTIME_REGISTRATION_MODES = new Set(["full", "runtime", "activate", "active"]);

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

function parsePortValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value >= 65536) return undefined;
    return value;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return undefined;
  return port;
}

function resolvePluginPort(pluginValue: unknown, envValue: string | undefined): number {
  return parsePortValue(pluginValue) ?? parsePortValue(envValue) ?? DEFAULT_PORT;
}

function parsePluginUpstreamUrl(pluginValue: unknown, envValue: string | undefined): string {
  if (typeof pluginValue === "string" && pluginValue.trim()) {
    return pluginValue;
  }

  return envValue ?? DEFAULT_BASE_URL;
}

function resolvePluginRuntimeConfig(api: OpenClawPluginApi): { port: number; upstreamUrl: string } {
  return {
    port: resolvePluginPort(api.pluginConfig?.port, process.env.DEEPSEEK_ROUTER_PORT),
    upstreamUrl: parsePluginUpstreamUrl(api.pluginConfig?.upstreamUrl, process.env.DEEPSEEK_BASE_URL),
  };
}

function readProviderConfig(api: OpenClawPluginApi): JsonObject {
  const models = api.config.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};

  const providers = (models as JsonObject).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};

  const provider = (providers as JsonObject)[DEEPSEEK_PROVIDER_ID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return {};

  return provider as JsonObject;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    }
  }
  return headers;
}

function resolveProviderRuntimeOverrides(api: OpenClawPluginApi): Pick<ProxyOptions, "apiKey" | "headers"> {
  const provider = readProviderConfig(api);
  const request = provider.request && typeof provider.request === "object" && !Array.isArray(provider.request)
    ? (provider.request as JsonObject)
    : {};
  const apiKey = typeof provider.apiKey === "string"
    ? provider.apiKey
    : typeof provider.api_key === "string"
      ? provider.api_key
      : undefined;
  const headers = {
    ...readStringRecord(provider.headers),
    ...readStringRecord(request.headers),
  };

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function isDuplicateProviderRegistrationError(error: unknown): boolean {
  return error instanceof Error && /provider already registered:\s*deepseek\b/i.test(error.message);
}

function shouldStartRuntimeProxy(registrationMode: string | undefined): boolean {
  if (registrationMode === undefined) return true;
  return RUNTIME_REGISTRATION_MODES.has(registrationMode);
}

async function closeProxyOnce(proxy: ProxyHandle): Promise<void> {
  if (closedProxies.has(proxy)) return;

  const closing = closingProxies.get(proxy);
  if (closing) {
    await closing;
    return;
  }

  const closePromise = (async () => {
    await proxy.close();
    closedProxies.add(proxy);

    if (activeProxy === proxy) {
      activeProxy = undefined;
    }
  })();
  closingProxies.set(proxy, closePromise);

  try {
    await closePromise;
  } finally {
    closingProxies.delete(proxy);
  }
}

async function closeActiveProxy(): Promise<void> {
  const previous = activeProxy;
  if (previous) {
    await closeProxyOnce(previous);
  }
}

async function replaceActiveProxy(proxy: ProxyHandle): Promise<void> {
  const previous = activeProxy;
  if (activeProxy === proxy) {
    return;
  }

  if (previous) {
    await closeProxyOnce(previous);
  }

  activeProxy = proxy;
}

function createProxyService(
  api: OpenClawPluginApi,
  runtime: PluginRuntime,
  port: number,
  upstreamUrl: string,
  providerBaseUrl: string,
): OpenClawService {
  let serviceProxy: ProxyHandle | undefined;

  return {
    id: "deepseek-router-proxy",
    async start() {
      try {
        if (serviceProxy && activeProxy === serviceProxy) {
          return;
        }

        if (serviceProxy) {
          await closeProxyOnce(serviceProxy);
          serviceProxy = undefined;
        }

        await closeActiveProxy();
        const proxy = await runtime.startProxy({
          port,
          baseUrl: upstreamUrl,
          ...resolveProviderRuntimeOverrides(api),
        });
        serviceProxy = proxy;
        await replaceActiveProxy(proxy);
        api.logger?.info?.(`DeepSeek Router Mini listening on ${providerBaseUrl}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger?.error?.(`DeepSeek Router Mini failed to start on port ${port}: ${message}`);
        throw error;
      }
    },
    async stop() {
      if (!serviceProxy) return;

      const proxy = serviceProxy;
      await closeProxyOnce(proxy);

      if (serviceProxy === proxy && activeProxy !== proxy) {
        serviceProxy = undefined;
      }
    },
  };
}

export function registerOpenClawPlugin(api: OpenClawPluginApi, runtime: PluginRuntime = defaultRuntime): void {
  const { port, upstreamUrl } = resolvePluginRuntimeConfig(api);
  const providerBaseUrl = localProviderBaseUrl(port);
  const shouldRegisterRuntimeService = shouldStartRuntimeProxy(api.registrationMode);
  const serviceId: OpenClawService["id"] = "deepseek-router-proxy";

  if (shouldRegisterRuntimeService) {
    api.registerService(createProxyService(api, runtime, port, upstreamUrl, providerBaseUrl));
  }

  try {
    api.registerProvider(createDeepSeekProvider(providerBaseUrl));
  } catch (error) {
    if (isDuplicateProviderRegistrationError(error)) {
      api.logger?.info?.("DeepSeek provider already registered; keeping router service active");
      injectDeepSeekModelsConfig(api.config, providerBaseUrl);
      return;
    }

    if (shouldRegisterRuntimeService) {
      api.unregisterService?.(serviceId);
    }
    throw error;
  }

  injectDeepSeekModelsConfig(api.config, providerBaseUrl);
}
