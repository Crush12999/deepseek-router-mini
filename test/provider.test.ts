import { describe, expect, it } from "vitest";

import type { RawConfig } from "../src/config-schema.js";
import {
  generateOpenClawModels,
  XIAOYI_PROVIDER_API,
  XIAOYI_PROVIDER_ID,
  XIAOYI_PROVIDER_NAME,
} from "../src/provider.js";

function createConfig(): RawConfig {
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
          name: "Xiaoyi Auto",
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
      cheap: {
        kind: "alias",
        candidates: ["deepseek-v4-pro", "deepseek-v4-flash"],
      },
      pro: {
        kind: "alias",
        candidates: ["deepseek-v4-pro"],
        selection: "first",
        metadata: {
          name: "Xiaoyi Pro",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 16_000,
          cost: {
            input: 0.61,
            output: 1.8,
            cacheRead: 0.15,
            cacheWrite: 0.61,
          },
        },
      },
    },
    routing: {
      tiers: {
        SIMPLE: { publicModel: "cheap" },
        MEDIUM: { publicModel: "cheap" },
        COMPLEX: { publicModel: "pro" },
        REASONING: { publicModel: "pro" },
      },
      structuredOutputMinTier: "MEDIUM",
      ambiguousDefaultTier: "MEDIUM",
    },
  };
}

describe("OpenClaw xiaoyi provider", () => {
  it("exports provider identity constants", () => {
    expect(XIAOYI_PROVIDER_ID).toBe("xiaoyiprovider");
    expect(XIAOYI_PROVIDER_NAME).toBe("Xiaoyi Provider");
    expect(XIAOYI_PROVIDER_API).toBe("openai-completions");
  });

  it("uses router metadata and alias metadata directly when generating OpenClaw models", () => {
    const config = createConfig();

    expect(generateOpenClawModels(config.publicModels, config.models)).toEqual([
      {
        id: "auto",
        name: "Xiaoyi Auto",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.28, output: 0.42, cacheRead: 0.07, cacheWrite: 0.28 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
      {
        id: "cheap",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.28, output: 0.42, cacheRead: 0.07, cacheWrite: 0.28 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
      {
        id: "pro",
        name: "Xiaoyi Pro",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.61, output: 1.8, cacheRead: 0.15, cacheWrite: 0.61 },
        contextWindow: 200_000,
        maxTokens: 16_000,
      },
    ]);
  });
});
