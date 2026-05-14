import type { ProxyConfig } from "./config-schema.js";

/**
 * 覆盖配置（来自 CLI flag 或插件 pluginConfig），所有字段可选
 *
 * 优先级规则：
 * - CLI flag 优先级最高（--port, --api-key, --headers 等）
 * - 插件 pluginConfig 次之（pluginConfig.port, pluginConfig.upstreamUrl 等）
 * - 配置文件最低
 *
 * 调用方负责按优先级合并多个覆盖源后再传入此函数。
 */
export interface ProxyConfigOverrides {
  port?: number;
  upstreamUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  trace?: "off" | "summary" | "debug";
}

export type { ProxyConfig };

/**
 * 将基础配置与覆盖配置合并，返回最终的 ProxyConfig。
 *
 * 覆盖优先级：overrides > baseConfig（逐字段覆盖）。
 *
 * headers 合并规则：
 * - 结果为 `{ ...baseConfig.headers, ...overrides.headers }`
 * - overrides.headers 中的 key 优先覆盖 baseConfig.headers 中相同的 key
 * - baseConfig.headers 中未被覆盖的 key 原样保留
 * - 若两者均无 headers，结果为 undefined
 *
 * @param baseConfig 来自配置文件的基础 proxy 配置
 * @param overrides  来自 CLI flag 或插件 pluginConfig 的覆盖配置（可选）
 * @returns 合并后的 ProxyConfig
 */
export function resolveProxyConfig(
  baseConfig: ProxyConfig,
  overrides: ProxyConfigOverrides = {},
): ProxyConfig {
  const mergedHeaders = mergeHeaders(baseConfig.headers, overrides.headers);

  return {
    port: overrides.port ?? baseConfig.port,
    upstreamUrl: overrides.upstreamUrl ?? baseConfig.upstreamUrl,
    apiKey: overrides.apiKey ?? baseConfig.apiKey,
    headers: mergedHeaders,
    trace: overrides.trace ?? baseConfig.trace,
  };
}

/**
 * 合并两个 headers 对象，override 优先。
 *
 * @param base     基础 headers（来自配置文件）
 * @param override 覆盖 headers（来自 CLI flag 或 pluginConfig）
 * @returns 合并后的 headers，若两者均为 undefined 则返回 undefined
 */
function mergeHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }
  return { ...base, ...override };
}
