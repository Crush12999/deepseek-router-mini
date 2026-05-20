import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 默认读取的 .xiaoyienv 路径。
 */
export const DEFAULT_XIAOYI_ENV_PATH = join(
  homedir(),
  ".openclaw",
  ".xiaoyienv",
);

/**
 * 默认仅允许把 X-UID 从环境文件映射到上游请求头，避免意外透传其他敏感字段。
 */
export const DEFAULT_XIAOYI_ENV_HEADER_MAP = Object.freeze({
  "X-UID": "X-UID",
}) satisfies Record<string, string>;

export type XiaoyiEnvConfig = {
  loaded: boolean;
  upstreamUrl?: string;
  headers?: Record<string, string>;
};

export type XiaoyiEnvReadOptions = {
  path?: string;
  headerMap?: unknown;
};

function createStringMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 解析 .xiaoyienv 文本。
 *
 * 仅接受 `KEY=value` 行；注释、空行、空 key/空 value 与无等号行都会被忽略。
 * 这里不做 shell 展开，也不会推断任何额外配置。
 * 返回 null-prototype map，避免后续读取时命中原型链属性。
 */
export function parseXiaoyiEnvContent(content: string): Record<string, string> {
  const values = createStringMap();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    values[key] = value;
  }

  return values;
}

/**
 * 规范化 env-key -> header-name 映射。
 *
 * 仅当输入缺失或不是对象时回退默认映射；对象内的非法项会被跳过。
 * 若调用方显式传入空对象或全非法对象，则返回空映射以允许关闭默认 X-UID 映射。
 * 结果同样使用 null-prototype map，确保 `"__proto__"` 等特殊 key 作为普通映射项被保留。
 */
export function normalizeXiaoyiEnvHeaderMap(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_XIAOYI_ENV_HEADER_MAP };
  }

  const normalized = createStringMap();

  for (const [envKey, headerName] of Object.entries(value)) {
    const trimmedEnvKey = envKey.trim();
    if (!trimmedEnvKey || !isNonEmptyString(headerName)) {
      continue;
    }

    normalized[trimmedEnvKey] = headerName.trim();
  }

  return normalized;
}

/**
 * 读取并提取 .xiaoyienv 中允许合并进 proxy 的配置。
 *
 * 该函数是容错边界：文件缺失、不可读或解析异常时一律返回 `{ loaded: false }`，
 * 且只暴露 `SERVICE_URL` 与白名单 header，不会推导 `apiKey` 或透传未映射字段。
 * 读取 header 前会校验 own key 与字符串值，避免把原型链上的函数等值带入请求头。
 */
export function readXiaoyiEnvConfig(
  options: XiaoyiEnvReadOptions = {},
): XiaoyiEnvConfig {
  const path = options.path ?? DEFAULT_XIAOYI_ENV_PATH;

  try {
    const values = parseXiaoyiEnvContent(readFileSync(path, "utf8"));
    const headerMap = normalizeXiaoyiEnvHeaderMap(options.headerMap);
    const headers = createStringMap();

    for (const [envKey, headerName] of Object.entries(headerMap)) {
      if (!hasOwn(values, envKey)) {
        continue;
      }

      const envValue = values[envKey];
      if (typeof envValue === "string") {
        headers[headerName] = envValue;
      }
    }

    const upstreamUrl =
      hasOwn(values, "SERVICE_URL") && typeof values.SERVICE_URL === "string"
        ? values.SERVICE_URL
        : undefined;
    const hasHeaders = Object.keys(headers).length > 0;
    const loaded = Boolean(upstreamUrl || hasHeaders);

    if (!loaded) {
      return { loaded: false };
    }

    return {
      loaded: true,
      ...(upstreamUrl ? { upstreamUrl } : {}),
      ...(hasHeaders ? { headers } : {}),
    };
  } catch {
    return { loaded: false };
  }
}
