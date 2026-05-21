import { loadConfig } from "./config-loader.js";
import { createDefaultRawConfig } from "./default-config.js";
import type { RawConfig } from "./config-schema.js";
import {
  resolveProxyConfig,
  type ProxyConfigOverrides,
} from "./proxy-config-resolver.js";
import { startProxy as startProxyImpl } from "./proxy.js";
import type {
  ConfigFallbackReason,
  ProxyHandle,
  ProxyHealthInfo,
  ProxyOptions,
} from "./proxy.js";
import {
  generateOpenClawModels,
  type OpenClawModelDefinition,
  LLM_ROUTER_PROVIDER_API,
  LLM_ROUTER_PROVIDER_ID,
} from "./provider.js";
import { readXiaoyiEnvConfig } from "./xiaoyi-env.js";

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
        defaultHeaders?: unknown;
        xiaoyiEnv?: {
          path?: unknown;
          headerMap?: unknown;
        };
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

/**
 * 插件侧安全配置解析结果。
 *
 * `config` 始终可用于启动 proxy；`health` 只暴露低泄漏兜底摘要；
 * `configError` 仅供日志记录，不应透传到 `/health`。
 */
type EnvConfigContribution = {
  upstreamUrlApplied: boolean;
  headers: Record<string, string>;
};

type RuntimeConfigResult = {
  config: RawConfig;
  health: ProxyHealthInfo;
  /**
   * 内部诊断：记录 env 对运行时配置的候选贡献，用于 service start 阶段
   * 在合并 provider/request 覆盖后重新计算低泄漏 health 标记。
   */
  envContribution: EnvConfigContribution;
  configError?: string;
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
const DEFAULT_FALLBACK_HEADERS = Object.freeze({
  "x-request-from": "openclaw",
});

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
 * 从 pluginConfig 加载配置。
 *
 * 这是严格解析入口：合法 inline/file 走 schema 校验，缺失配置仍抛错，
 * 由更外层的 `resolvePluginRuntimeConfig()` 决定是否进入默认配置兜底。
 */
export function resolvePluginConfig(api: OpenClawPluginApi): RawConfig {
  const inline = api.pluginConfig?.config;
  const path = api.pluginConfig?.configPath;

  if (hasInlineConfig(inline)) {
    return loadConfig({ kind: "inline", config: inline as RawConfig });
  }
  if (hasConfigPath(path)) {
    return loadConfig({ kind: "file", path: path as string });
  }

  throw new Error(
    "llm-router: missing config. Set pluginConfig.config or pluginConfig.configPath",
  );
}

/**
 * 把未知错误收敛成稳定字符串，供 logger 使用。
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 只有非 null / undefined 的值才算“真正提供了 inline config”。
 *
 * 这样可以避免 `config: null` 或 `config: undefined` 这类占位字段遮蔽合法
 * `configPath`，并让“仅有空占位字段”的场景回落到缺失配置分支。
 */
function hasInlineConfig(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * pluginConfig.configPath 只有是非空字符串时才算可用文件配置来源。
 */
function hasConfigPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 把配置加载异常收敛到稳定枚举，避免插件层暴露底层错误细节。
 */
function classifyConfigLoadError(error: unknown): ConfigFallbackReason {
  if (error instanceof SyntaxError) {
    return "config_json_parse_error";
  }

  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: unknown }).code === "ENOENT"
      ? "config_path_not_found"
      : "config_file_read_error";
  }

  return "config_schema_error";
}

/**
 * 缺失主配置时的插件边界兜底：返回可启动的默认配置与低泄漏 health 摘要。
 */
function fallbackConfig(
  reason: ConfigFallbackReason,
  error?: unknown,
): RuntimeConfigResult {
  return {
    config: createDefaultRawConfig(),
    health: {
      degraded: true,
      config: {
        source: "default",
        fallbackReason: reason,
        envFileLoaded: false,
      },
    },
    envContribution: { upstreamUrlApplied: false, headers: {} },
    ...(error ? { configError: formatError(error) } : {}),
  };
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
 * 提取 pluginConfig 允许覆盖的 proxy 运行时字段。
 */
function resolvePluginProxyOverrides(
  api: OpenClawPluginApi,
): ProxyConfigOverrides {
  return {
    port: parsePortValue(api.pluginConfig?.port),
    upstreamUrl:
      typeof api.pluginConfig?.upstreamUrl === "string" &&
      api.pluginConfig.upstreamUrl.trim()
        ? api.pluginConfig.upstreamUrl
        : undefined,
    trace: normalizeTraceOverride(api.pluginConfig?.trace),
  };
}

/**
 * 读取 pluginConfig.xiaoyiEnv；非法结构直接忽略，避免把宿主任意对象透传给 env 解析器。
 */
function readXiaoyiEnvOptions(api: OpenClawPluginApi): {
  path?: string;
  headerMap?: unknown;
} {
  const value = api.pluginConfig?.xiaoyiEnv;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const envConfig = value as { path?: unknown; headerMap?: unknown };

  const path =
    typeof envConfig.path === "string" && envConfig.path.trim().length > 0
      ? envConfig.path
      : undefined;

  return {
    ...(path ? { path } : {}),
    headerMap: envConfig.headerMap,
  };
}

/**
 * 读取默认兜底配置专用 headers；非法项跳过，避免破坏兜底启动。
 */
function readDefaultHeaders(
  api: OpenClawPluginApi,
): Record<string, string> | undefined {
  const value = api.pluginConfig?.defaultHeaders;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;

  const headers = Object.create(null) as Record<string, string>;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || typeof rawValue !== "string") continue;

    const headerValue = rawValue.trim();
    if (!headerValue) continue;

    headers[key] = headerValue;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 按大小写不敏感规则合并可选 headers；若最终为空则回退为 undefined。
 */
function mergeOptionalHeadersByCase(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const definedRecords = records.filter(
    (record): record is Record<string, string> => record !== undefined,
  );
  const merged = mergeHeaders(...definedRecords);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 生成大小写不敏感的 header key 集合，用于判断高优先级来源是否覆盖 env。
 */
function createHeaderKeySet(
  headers: Record<string, string> | undefined,
): Set<string> {
  return new Set(Object.keys(headers ?? {}).map((key) => key.toLowerCase()));
}

/**
 * 排除已被更高优先级 headers 覆盖的 env headers。
 *
 * header 覆盖按大小写不敏感匹配；只要高优先级来源提供同名 header，
 * 即使值完全相同，也不再把该 env header 视为真实生效。
 */
function omitHeadersCoveredBy(
  envHeaders: Record<string, string> | undefined,
  coveringHeaders: Record<string, string> | undefined,
): Record<string, string> {
  if (!envHeaders) return {};

  const coveringKeys = createHeaderKeySet(coveringHeaders);
  const appliedHeaders = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(envHeaders)) {
    if (!coveringKeys.has(key.toLowerCase())) {
      appliedHeaders[key] = value;
    }
  }
  return appliedHeaders;
}

/**
 * 判断 env headers 是否至少有一项由 env 来源进入当前 proxy headers。
 *
 * `higherPriorityHeaders` 用来显式记录后续覆盖来源；不能仅靠最终 key/value
 * 相等判断来源，因为更高优先级 header 可能用相同值覆盖 env。
 */
function hasAppliedEnvHeaders(
  proxyHeaders: Record<string, string> | undefined,
  envHeaders: Record<string, string> | undefined,
  higherPriorityHeaders?: Record<string, string>,
): boolean {
  if (!proxyHeaders || !envHeaders) return false;
  const envHeadersNotCovered = omitHeadersCoveredBy(
    envHeaders,
    higherPriorityHeaders,
  );

  return Object.entries(envHeadersNotCovered).some(([envKey, envValue]) => {
    const appliedKey = Object.keys(proxyHeaders).find(
      (candidate) => candidate.toLowerCase() === envKey.toLowerCase(),
    );
    return appliedKey !== undefined && proxyHeaders[appliedKey] === envValue;
  });
}

/**
 * 合并 proxy 覆盖项，但 headers 使用插件边界要求的大小写不敏感覆盖规则。
 *
 * `resolveProxyConfig()` 仍负责 port、upstreamUrl、apiKey 和 trace 的字段优先级；
 * 本包装只修正普通对象展开会同时保留 `X-UID`/`x-uid` 的 header 场景。
 */
function resolveProxyConfigWithCaseInsensitiveHeaders(
  baseProxy: RawConfig["proxy"],
  overrides: ProxyConfigOverrides,
): RawConfig["proxy"] {
  const resolved = resolveProxyConfig(baseProxy, overrides);

  return {
    ...resolved,
    headers: mergeOptionalHeadersByCase(baseProxy.headers, overrides.headers),
  };
}

/**
 * 组合主配置与 pluginConfig 运行时覆盖项。
 *
 * 本函数是插件配置加载失败的最后兜底边界：缺失配置时改用默认配置，
 * 其余合法 inline/file 继续走严格配置解析。
 */
function resolvePluginRuntimeConfig(
  api: OpenClawPluginApi,
): RuntimeConfigResult {
  const inline = api.pluginConfig?.config;
  const path = api.pluginConfig?.configPath;
  let runtimeConfigResult: RuntimeConfigResult;

  if (hasInlineConfig(inline)) {
    try {
      runtimeConfigResult = {
        config: resolvePluginConfig(api),
        health: {
          degraded: false,
          config: {
            source: "inline",
            envFileLoaded: false,
          },
        },
        envContribution: { upstreamUrlApplied: false, headers: {} },
      };
    } catch (error) {
      runtimeConfigResult = fallbackConfig("config_schema_error", error);
    }
  } else if (hasConfigPath(path)) {
    try {
      runtimeConfigResult = {
        config: resolvePluginConfig(api),
        health: {
          degraded: false,
          config: {
            source: "file",
            envFileLoaded: false,
          },
        },
        envContribution: { upstreamUrlApplied: false, headers: {} },
      };
    } catch (error) {
      runtimeConfigResult = fallbackConfig(
        classifyConfigLoadError(error),
        error,
      );
    }
  } else {
    runtimeConfigResult = fallbackConfig("missing_config");
  }

  const env = readXiaoyiEnvConfig(readXiaoyiEnvOptions(api));
  const source = runtimeConfigResult.health.config.source;
  const pluginOverrides = resolvePluginProxyOverrides(api);
  const envUpstreamUrl = source === "default" ? env.upstreamUrl : undefined;
  const defaultFallbackHeaders =
    source === "default"
      ? mergeOptionalHeadersByCase(
          DEFAULT_FALLBACK_HEADERS,
          readDefaultHeaders(api),
        )
      : undefined;
  const rawCoveredEnvHeaders =
    source === "default"
      ? (env.headers ?? {})
      : omitHeadersCoveredBy(
          env.headers,
          runtimeConfigResult.config.proxy.headers,
        );
  const proxyWithEnv: RawConfig["proxy"] = {
    ...runtimeConfigResult.config.proxy,
    ...(envUpstreamUrl ? { upstreamUrl: envUpstreamUrl } : {}),
    headers:
      source === "default"
        ? mergeOptionalHeadersByCase(
            defaultFallbackHeaders,
            runtimeConfigResult.config.proxy.headers,
            env.headers,
          )
        : mergeOptionalHeadersByCase(
            env.headers,
            runtimeConfigResult.config.proxy.headers,
          ),
  };
  const finalProxy = resolveProxyConfigWithCaseInsensitiveHeaders(
    proxyWithEnv,
    pluginOverrides,
  );
  const envUpstreamApplied =
    envUpstreamUrl !== undefined && pluginOverrides.upstreamUrl === undefined;
  const pluginCoveredEnvHeaders = omitHeadersCoveredBy(
    rawCoveredEnvHeaders,
    pluginOverrides.headers,
  );
  const envHeadersApplied = hasAppliedEnvHeaders(
    finalProxy.headers,
    pluginCoveredEnvHeaders,
  );

  return {
    ...runtimeConfigResult,
    health: {
      ...runtimeConfigResult.health,
      config: {
        ...runtimeConfigResult.health.config,
        envFileLoaded: envUpstreamApplied || envHeadersApplied,
      },
    },
    envContribution: {
      upstreamUrlApplied: envUpstreamApplied,
      headers: pluginCoveredEnvHeaders,
    },
    config: {
      ...runtimeConfigResult.config,
      proxy: finalProxy,
    },
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

  const headers = Object.create(null) as Record<string, string>;
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
  const headers = Object.create(null) as Record<string, string>;

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
 * 根据最终 startProxy 配置重新计算 env 是否真实生效。
 *
 * provider/request headers 会在 service start 阶段才合并，因此 health 标记必须
 * 延后到这里按最终 headers 核算，避免被同名覆盖的 env header 误报为已加载。
 */
function resolveEffectiveHealth(
  health: ProxyHealthInfo,
  envContribution: EnvConfigContribution,
  startConfig: RawConfig,
  providerHeaders: Record<string, string> | undefined,
): ProxyHealthInfo {
  return {
    ...health,
    config: {
      ...health.config,
      envFileLoaded:
        envContribution.upstreamUrlApplied ||
        hasAppliedEnvHeaders(
          startConfig.proxy.headers,
          envContribution.headers,
          providerHeaders,
        ),
    },
  };
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
  health: ProxyHealthInfo,
  envContribution: EnvConfigContribution,
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
          proxy: resolveProxyConfigWithCaseInsensitiveHeaders(
            runtimeConfig.proxy,
            providerOverrides,
          ),
        };
        const startHealth = resolveEffectiveHealth(
          health,
          envContribution,
          startConfig,
          providerOverrides.headers,
        );

        // 先停旧实例，再切新实例，避免 OpenClaw 多次 start 时出现重复监听。
        await closeActiveProxy();
        const proxy = await runtime.startProxy({
          config: startConfig,
          traceLogger: createTraceLogger(api),
          session: {},
          health: startHealth,
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
  const runtimeConfigResult = resolvePluginRuntimeConfig(api);
  const runtimeConfig = runtimeConfigResult.config;
  const providerBaseUrl = localProviderBaseUrl(runtimeConfig.proxy.port);
  const models = generateOpenClawModels(
    runtimeConfig.publicModels,
    runtimeConfig.models,
  );
  const shouldRegisterRuntimeService = shouldStartRuntimeProxy(
    api.registrationMode,
  );

  if (runtimeConfigResult.health.degraded) {
    api.logger?.info?.(
      `LLM Router using default config (${runtimeConfigResult.health.config.fallbackReason}); port=${runtimeConfig.proxy.port}; upstreamUrl=${runtimeConfig.proxy.upstreamUrl}`,
    );
    if (runtimeConfigResult.configError) {
      api.logger?.error?.(
        `LLM Router config load failed: ${runtimeConfigResult.configError}`,
      );
    }
  }

  if (!shouldRegisterRuntimeService) {
    injectLlmRouterModelsConfig(api.config, providerBaseUrl, models);
    return;
  }

  const previousConfig = structuredClone(api.config);
  injectLlmRouterModelsConfig(api.config, providerBaseUrl, models);
  try {
    api.registerService(
      createProxyService(
        api,
        runtime,
        runtimeConfig,
        runtimeConfigResult.health,
        runtimeConfigResult.envContribution,
        providerBaseUrl,
        models,
      ),
    );
  } catch (error) {
    for (const key of Object.keys(api.config)) {
      delete api.config[key];
    }
    Object.assign(api.config, previousConfig);
    throw error;
  }
}
