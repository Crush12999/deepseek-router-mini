import type { RawConfig } from "./config-schema.js";

/**
 * 递归冻结对象与其嵌套成员，避免共享默认配置在运行时被污染。
 */
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}

function buildDefaultRawConfig(): RawConfig {
  return {
    version: 1,
    proxy: {
      port: 8402,
      upstreamUrl: "https://api.deepseek.com",
      trace: "off",
    },
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        inputPrice: 0.28,
        outputPrice: 0.42,
        contextWindow: 1_000_000,
        maxOutput: 64_000,
        reasoning: true,
        toolCalling: true,
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        inputPrice: 0.56,
        outputPrice: 1.68,
        contextWindow: 1_000_000,
        maxOutput: 64_000,
        reasoning: true,
        toolCalling: true,
      },
    ],
    publicModels: {
      auto: {
        kind: "router",
        metadata: {
          name: "LLM Router Auto",
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          cost: {
            input: 0.28,
            output: 0.42,
            cacheRead: 0.07,
            cacheWrite: 0.28,
          },
        },
      },
      flash: {
        kind: "alias",
        candidates: ["deepseek-v4-flash"],
        selection: "first",
      },
      pro: {
        kind: "alias",
        candidates: ["deepseek-v4-pro"],
        selection: "first",
      },
    },
    routing: {
      tiers: {
        SIMPLE: { publicModel: "flash" },
        MEDIUM: { publicModel: "flash", fallback: ["pro"] },
        COMPLEX: { publicModel: "pro" },
        REASONING: { publicModel: "pro" },
      },
      structuredOutputMinTier: "MEDIUM",
      ambiguousDefaultTier: "MEDIUM",
      tierBoundaries: {
        simpleMedium: 0,
        mediumComplex: 0.3,
        complexReasoning: 0.5,
      },
      confidenceThreshold: 0.7,
    },
  };
}

/**
 * 配置加载失败时使用的内置兜底配置，不包含真实密钥。
 */
export const DEFAULT_RAW_CONFIG: RawConfig = deepFreeze(
  buildDefaultRawConfig(),
);

/**
 * 返回一份可变的默认配置副本，供调用方安全修改而不影响共享兜底配置。
 */
export function createDefaultRawConfig(): RawConfig {
  return structuredClone(DEFAULT_RAW_CONFIG);
}
