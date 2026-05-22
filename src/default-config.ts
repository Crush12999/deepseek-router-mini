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
        id: "LLM_DeepSeekV4_Thinking",
        name: "LLM_DeepSeekV4_Thinking",
        inputPrice: 0.001,
        outputPrice: 0.002,
        contextWindow: 256_000,
        maxOutput: 6_000,
        reasoning: true,
        toolCalling: true,
      },
    ],
    publicModels: {
      auto: {
        kind: "router",
        metadata: {
          name: "LLM-Router-Auto",
          reasoning: true,
          contextWindow: 256_000,
          maxTokens: 6_000,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
      flash: {
        kind: "alias",
        candidates: ["LLM_DeepSeekV4_Thinking"],
        selection: "first",
      },
      pro: {
        kind: "alias",
        candidates: ["LLM_DeepSeekV4_Thinking"],
        selection: "first",
      },
    },
    routing: {
      tiers: {
        SIMPLE: { publicModel: "flash" },
        MEDIUM: { publicModel: "flash" },
        COMPLEX: { publicModel: "pro" },
        REASONING: { publicModel: "pro" },
      },
      structuredOutputMinTier: "MEDIUM",
      ambiguousDefaultTier: "MEDIUM",
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
