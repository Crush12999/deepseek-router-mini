import { DEFAULT_BASE_URL, DEFAULT_PORT } from "./config.js";
import { loadConfig } from "./config-loader.js";
import type { RawConfig } from "./config-schema.js";
import { startProxy as startProxyImpl } from "./proxy.js";
import type { ProxyHandle, ProxyOptions } from "./proxy.js";
import {
  XIAOYI_OPENCLAW_MODELS,
  XIAOYI_PROVIDER_API,
  XIAOYI_PROVIDER_ID,
} from "./provider.js";

type JsonObject = Record<string, unknown>;

export type OpenClawService = {
  id: "xiaoyi-router-proxy";
  start: (ctx?: unknown) => Promise<void>;
  stop: (ctx?: unknown) => Promise<void>;
};

export type OpenClawPluginApi = {
  config: JsonObject;
  pluginConfig?: {
    port?: unknown;
    upstreamUrl?: unknown;
    config?: RawConfig;
    configPath?: string;
  } | Record<string, unknown>;
  registrationMode?: string;
  registerProvider?: (provider: unknown) => void;
  registerService: (service: OpenClawService) => void;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type OpenClawPlugin = {
  id: "xiaoyi-router";
  name: "Xiaoyi Router";
  description: "Xiaoyi local routing proxy for OpenClaw";
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

function createTraceLogger(api: OpenClawPluginApi): ProxyOptions["traceLogger"] {
  return {
    debug: (message) => {
      if (api.logger?.debug) {
        api.logger.debug(message);
        return;
      }
      api.logger?.info?.(message);
    },
    info: (message) => {
      api.logger?.info?.(message);
    },
  };
}

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

export function injectXiaoyiModelsConfig(config: JsonObject, providerBaseUrl: string): void {
  const models = ensureObject(config, "models");
  const providers = ensureObject(models, "providers");
  const current = providers[XIAOYI_PROVIDER_ID];
  const existing =
    current && typeof current === "object" && !Array.isArray(current) ? (current as JsonObject) : {};

  providers[XIAOYI_PROVIDER_ID] = {
    ...existing,
    baseUrl: providerBaseUrl,
    api: XIAOYI_PROVIDER_API,
    ...("apiKey" in existing ? { apiKey: existing.apiKey } : {}),
    models: XIAOYI_OPENCLAW_MODELS,
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

/**
 * 从 pluginConfig 加载配置
 * @param api OpenClaw 插件 API
 * @returns 解析后的配置对象，或 undefined 如果未提供配置源（向后兼容）
 * @throws {Error} 如果 pluginConfig 存在但 config 和 configPath 都缺失
 */
export function resolvePluginConfig(api: OpenClawPluginApi): RawConfig | undefined {
  const inline = api.pluginConfig?.config;
  const path = api.pluginConfig?.configPath;

  if (inline) {
    return loadConfig({ kind: "inline", config: inline as RawConfig });
  }
  if (path) {
    return loadConfig({ kind: "file", path: path as string });
  }
  // 如果 pluginConfig 存在且有非 port/upstreamUrl 的字段，说明用户意图提供配置但遗漏了
  // 如果 pluginConfig 不存在或只有 port/upstreamUrl，向后兼容使用默认值
  if (api.pluginConfig && !api.pluginConfig.port && !api.pluginConfig.upstreamUrl) {
    throw new Error("xiaoyi-router: missing config. Set pluginConfig.config or pluginConfig.configPath");
  }
  return undefined;
}

function resolvePluginRuntimeConfig(api: OpenClawPluginApi): { port: number; upstreamUrl: string } {
  const config = resolvePluginConfig(api);
  const portOverride = parsePortValue(api.pluginConfig?.port);
  const upstreamOverride = typeof api.pluginConfig?.upstreamUrl === "string" && api.pluginConfig.upstreamUrl.trim()
    ? api.pluginConfig.upstreamUrl
    : undefined;

  if (config) {
    return {
      port: portOverride ?? config.proxy.port,
      upstreamUrl: upstreamOverride ?? config.proxy.upstreamUrl,
    };
  }

  // 向后兼容：无配置源时使用默认值
  return {
    port: portOverride ?? DEFAULT_PORT,
    upstreamUrl: upstreamOverride ?? DEFAULT_BASE_URL,
  };
}

function readProviderConfig(api: OpenClawPluginApi): JsonObject {
  const models = api.config.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};

  const providers = (models as JsonObject).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};

  const provider = (providers as JsonObject)[XIAOYI_PROVIDER_ID];
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

function mergeHeaders(...records: Array<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const existingKey = Object.keys(headers).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (existingKey) {
        delete headers[existingKey];
      }
      headers[key] = value;
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
  const headers = mergeHeaders(readStringRecord(provider.headers), readStringRecord(request.headers));

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
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
    id: "xiaoyi-router-proxy",
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
          traceLogger: createTraceLogger(api),
          ...resolveProviderRuntimeOverrides(api),
        });
        serviceProxy = proxy;
        await replaceActiveProxy(proxy);
        api.logger?.info?.(`Xiaoyi Router listening on ${providerBaseUrl}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger?.error?.(`Xiaoyi Router failed to start on port ${port}: ${message}`);
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

  if (!shouldRegisterRuntimeService) {
    injectXiaoyiModelsConfig(api.config, providerBaseUrl);
    return;
  }

  const previousConfig = structuredClone(api.config);
  injectXiaoyiModelsConfig(api.config, providerBaseUrl);
  try {
    api.registerService(createProxyService(api, runtime, port, upstreamUrl, providerBaseUrl));
  } catch (error) {
    for (const key of Object.keys(api.config)) {
      delete api.config[key];
    }
    Object.assign(api.config, previousConfig);
    throw error;
  }
}
