import { loadConfig } from "./config-loader.js";
import type { RawConfig } from "./config-schema.js";
import {
  resolveProxyConfig,
  type ProxyConfigOverrides,
} from "./proxy-config-resolver.js";
import { startProxy as startProxyImpl } from "./proxy.js";
import type { ProxyHandle, ProxyOptions } from "./proxy.js";
import {
  generateOpenClawModels,
  type OpenClawModelDefinition,
  LLM_ROUTER_PROVIDER_API,
  LLM_ROUTER_PROVIDER_ID,
} from "./provider.js";

type JsonObject = Record<string, unknown>;

export type OpenClawService = {
  id: "llm-router-proxy";
  start: (ctx?: unknown) => Promise<void>;
  stop: (ctx?: unknown) => Promise<void>;
};

export type OpenClawPluginApi = {
  config: JsonObject;
  pluginConfig?:
    | {
        port?: unknown;
        upstreamUrl?: unknown;
        trace?: unknown;
        config?: RawConfig;
        configPath?: string;
      }
    | Record<string, unknown>;
  registrationMode?: string;
  runtime?: {
    config?: {
      mutateConfigFile?: <T = void>(params: {
        afterWrite: { mode: "auto" } | { mode: "none"; reason: string };
        mutate: (draft: JsonObject) => T | void | Promise<T | void>;
      }) => Promise<unknown>;
    };
  };
  registerProvider?: (provider: unknown) => void;
  registerService: (service: OpenClawService) => void;
  logger?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type OpenClawPlugin = {
  id: "llm-router";
  name: "LLM Router";
  description: "LLM Router local routing proxy for OpenClaw";
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
const RUNTIME_REGISTRATION_MODES = new Set([
  "full",
  "runtime",
  "activate",
  "active",
]);

/**
 * 将 Router trace 适配到 OpenClaw 的 logger 接口。
 *
 * 优先走 `debug`；如果宿主没有提供 `debug`，则降级到 `info`。
 */
function createTraceLogger(
  api: OpenClawPluginApi,
): ProxyOptions["traceLogger"] {
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

/**
 * 确保某个配置节点是可写对象；若不存在或类型不对，则直接替换为空对象。
 */
function ensureObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const created: JsonObject = {};
    parent[key] = created;
    return created;
  }
  return value as JsonObject;
}

/**
 * 计算 Router 本地 provider base URL。
 */
export function localProviderBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * 把 Router 管理的 provider 配置注入到 OpenClaw 全局配置里。
 *
 * 关键策略：虽然 `provider.ts` 会生成完整 alias 元数据，但真正写回 OpenClaw
 * 时只暴露 `auto`，从而把 alias 选择权完全留在 Router 内部。
 */
export function injectLlmRouterModelsConfig(
  config: JsonObject,
  providerBaseUrl: string,
  modelDefinitions: OpenClawModelDefinition[],
): void {
  const modelsConfig = ensureObject(config, "models");
  const providers = ensureObject(modelsConfig, "providers");
  const current = providers[LLM_ROUTER_PROVIDER_ID];
  const existing =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as JsonObject)
      : {};

  providers[LLM_ROUTER_PROVIDER_ID] = {
    ...existing,
    baseUrl: providerBaseUrl,
    api: LLM_ROUTER_PROVIDER_API,
    models: modelDefinitions.filter((model) => model.id === "auto"),
  };
}

/**
 * 解析 pluginConfig.port，非法值直接忽略，回退到配置文件中的端口。
 */
function parsePortValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0 || value >= 65536)
      return undefined;
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
 * @returns 解析后的配置对象
 * @throws {Error} 如果缺少 config/configPath
 */
export function resolvePluginConfig(api: OpenClawPluginApi): RawConfig {
  const inline = api.pluginConfig?.config;
  const path = api.pluginConfig?.configPath;

  if (inline) {
    return loadConfig({ kind: "inline", config: inline as RawConfig });
  }
  if (path) {
    return loadConfig({ kind: "file", path: path as string });
  }

  throw new Error(
    "llm-router: missing config. Set pluginConfig.config or pluginConfig.configPath",
  );
}

/**
 * 只接受三种已知 trace 覆盖值；其余输入统一视为“未覆盖”。
 */
function normalizeTraceOverride(
  value: unknown,
): "off" | "summary" | "debug" | undefined {
  return value === "off" || value === "summary" || value === "debug"
    ? value
    : undefined;
}

/**
 * 组合配置文件与 pluginConfig 中允许的运行时覆盖项。
 */
function resolvePluginRuntimeConfig(api: OpenClawPluginApi): RawConfig {
  const config = resolvePluginConfig(api);
  const portOverride = parsePortValue(api.pluginConfig?.port);
  const upstreamOverride =
    typeof api.pluginConfig?.upstreamUrl === "string" &&
    api.pluginConfig.upstreamUrl.trim()
      ? api.pluginConfig.upstreamUrl
      : undefined;
  return {
    ...config,
    proxy: resolveProxyConfig(config.proxy, {
      port: portOverride,
      upstreamUrl: upstreamOverride,
      trace: normalizeTraceOverride(api.pluginConfig?.trace),
    }),
  };
}

/**
 * 从 OpenClaw 全局配置中读回当前 provider 配置。
 *
 * 这么做是为了保留用户已经写在 provider 节点上的鉴权和 header 覆盖项。
 */
function readProviderConfig(api: OpenClawPluginApi): JsonObject {
  const models = api.config.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return {};

  const providers = (models as JsonObject).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return {};

  const provider = (providers as JsonObject)[LLM_ROUTER_PROVIDER_ID];
  if (!provider || typeof provider !== "object" || Array.isArray(provider))
    return {};

  return provider as JsonObject;
}

/**
 * 只提取形如 `{ [key]: string }` 的纯字符串 map。
 */
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

/**
 * 合并多份 headers，后者按大小写不敏感规则覆盖前者。
 */
function mergeHeaders(
  ...records: Array<Record<string, string>>
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      const existingKey = Object.keys(headers).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      if (existingKey) {
        delete headers[existingKey];
      }
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * 从 OpenClaw provider 节点反推 Router 运行时覆盖项。
 *
 * 允许用户把 `apiKey`、`api_key`、`headers` 和 `request.headers` 继续挂在
 * provider 下，而 Router 在启动时会把它们重新吸收回来。
 */
function resolveProviderRuntimeOverrides(
  api: OpenClawPluginApi,
): ProxyConfigOverrides {
  const provider = readProviderConfig(api);
  const request =
    provider.request &&
    typeof provider.request === "object" &&
    !Array.isArray(provider.request)
      ? (provider.request as JsonObject)
      : {};
  const apiKey =
    typeof provider.apiKey === "string"
      ? provider.apiKey
      : typeof provider.api_key === "string"
        ? provider.api_key
        : undefined;
  const headers = mergeHeaders(
    readStringRecord(provider.headers),
    readStringRecord(request.headers),
  );

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * OpenClaw 在插件注册时传入的 `api.config` 是运行时快照；直接修改它不会自动
 * 落盘。运行态启动时如果宿主提供正式的 config mutation API，则把同一份
 * provider 修复持久化到 openclaw.json。
 */
async function persistLlmRouterModelsConfig(
  api: OpenClawPluginApi,
  providerBaseUrl: string,
  modelDefinitions: OpenClawModelDefinition[],
): Promise<void> {
  const mutateConfigFile = api.runtime?.config?.mutateConfigFile;
  if (!mutateConfigFile) return;

  await mutateConfigFile({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      injectLlmRouterModelsConfig(draft, providerBaseUrl, modelDefinitions);
    },
  });
}

/**
 * 只有在运行态注册模式下才启动本地 HTTP proxy 服务。
 */
function shouldStartRuntimeProxy(
  registrationMode: string | undefined,
): boolean {
  if (registrationMode === undefined) return true;
  return RUNTIME_REGISTRATION_MODES.has(registrationMode);
}

/**
 * 幂等关闭某个 proxy handle，避免并发 stop / replace 时重复 close。
 */
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

/**
 * 停掉当前全局 active proxy（如果存在）。
 */
async function closeActiveProxy(): Promise<void> {
  const previous = activeProxy;
  if (previous) {
    await closeProxyOnce(previous);
  }
}

/**
 * 用新 proxy 替换当前 active proxy，先安全关闭旧实例。
 */
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

/**
 * 为 OpenClaw 注册的运行态 service 包装层。
 *
 * 它负责：
 * 1. 读取 provider 节点上的运行时覆盖项；
 * 2. 启动本地 Router；
 * 3. 保证线程内只保留一个 active proxy；
 * 4. 将启动 / 失败信息写入宿主 logger。
 */
function createProxyService(
  api: OpenClawPluginApi,
  runtime: PluginRuntime,
  runtimeConfig: RawConfig,
  providerBaseUrl: string,
  modelDefinitions: OpenClawModelDefinition[],
): OpenClawService {
  let serviceProxy: ProxyHandle | undefined;

  return {
    id: "llm-router-proxy",
    async start() {
      try {
        if (serviceProxy && activeProxy === serviceProxy) {
          return;
        }

        if (serviceProxy) {
          await closeProxyOnce(serviceProxy);
          serviceProxy = undefined;
        }

        await persistLlmRouterModelsConfig(
          api,
          providerBaseUrl,
          modelDefinitions,
        );
        const providerOverrides = resolveProviderRuntimeOverrides(api);
        const startConfig: RawConfig = {
          ...runtimeConfig,
          proxy: resolveProxyConfig(runtimeConfig.proxy, providerOverrides),
        };

        // 先停旧实例，再切新实例，避免 OpenClaw 多次 start 时出现重复监听。
        await closeActiveProxy();
        const proxy = await runtime.startProxy({
          config: startConfig,
          traceLogger: createTraceLogger(api),
          session: {},
        });
        serviceProxy = proxy;
        await replaceActiveProxy(proxy);
        api.logger?.info?.(`LLM Router listening on ${providerBaseUrl}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger?.error?.(
          `LLM Router failed to start on port ${runtimeConfig.proxy.port}: ${message}`,
        );
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

/**
 * OpenClaw 插件主注册函数。
 *
 * 注册顺序很关键：
 * 1. 先解析运行时配置；
 * 2. 生成 provider 元数据；
 * 3. 把 `auto` 注入到 OpenClaw；
 * 4. 只有在运行态模式下才真正注册并启动本地 proxy service。
 */
export function registerOpenClawPlugin(
  api: OpenClawPluginApi,
  runtime: PluginRuntime = defaultRuntime,
): void {
  const runtimeConfig = resolvePluginRuntimeConfig(api);
  const providerBaseUrl = localProviderBaseUrl(runtimeConfig.proxy.port);
  const models = generateOpenClawModels(
    runtimeConfig.publicModels,
    runtimeConfig.models,
  );
  const shouldRegisterRuntimeService = shouldStartRuntimeProxy(
    api.registrationMode,
  );

  if (!shouldRegisterRuntimeService) {
    injectLlmRouterModelsConfig(api.config, providerBaseUrl, models);
    return;
  }

  const previousConfig = structuredClone(api.config);
  injectLlmRouterModelsConfig(api.config, providerBaseUrl, models);
  try {
    api.registerService(
      createProxyService(api, runtime, runtimeConfig, providerBaseUrl, models),
    );
  } catch (error) {
    for (const key of Object.keys(api.config)) {
      delete api.config[key];
    }
    Object.assign(api.config, previousConfig);
    throw error;
  }
}
