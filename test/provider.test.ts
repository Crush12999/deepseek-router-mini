import { describe, expect, it } from "vitest";

import {
  XIAOYI_OPENCLAW_MODELS,
  XIAOYI_PROVIDER_ID,
  createXiaoyiProvider,
} from "../src/provider.js";

describe("OpenClaw xiaoyi provider", () => {
  it("defines the xiaoyiprovider provider with aliases and a local OpenAI-compatible baseUrl", () => {
    const provider = createXiaoyiProvider("http://127.0.0.1:8402/v1");

    expect(provider).toMatchObject({
      id: XIAOYI_PROVIDER_ID,
      name: "Xiaoyi Provider",
      aliases: ["xiaoyi"],
    });
    expect(provider.models.baseUrl).toBe("http://127.0.0.1:8402/v1");
    expect(provider.models.api).toBe("openai-completions");
    expect(provider.auth).toEqual([]);
  });

  it("exposes complete OpenClaw model definitions", () => {
    expect(XIAOYI_OPENCLAW_MODELS.map((model) => model.id)).toEqual([
      "auto",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);

    expect(XIAOYI_OPENCLAW_MODELS).toEqual([
      {
        id: "auto",
        name: "Xiaoyi Auto",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.28, output: 0.42, cacheRead: 0.07, cacheWrite: 0.28 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.56, output: 1.68, cacheRead: 0.14, cacheWrite: 0.56 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
    ]);
  });
});
