import { afterEach, describe, expect, it, vi } from "vitest";

import { DEEPSEEK_OPENCLAW_MODELS } from "../src/provider.js";
import { injectDeepSeekModelsConfig, localProviderBaseUrl } from "../src/plugin.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("OpenClaw plugin config injection", () => {
  it("builds the local provider baseUrl from the configured port", () => {
    expect(localProviderBaseUrl(8402)).toBe("http://127.0.0.1:8402/v1");
  });

  it("creates missing models.providers.deepseek without inventing an apiKey", () => {
    const config: Record<string, unknown> = {};

    injectDeepSeekModelsConfig(config, "http://127.0.0.1:8402/v1");

    expect(config).toEqual({
      models: {
        providers: {
          deepseek: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
            apiKey: undefined,
            models: DEEPSEEK_OPENCLAW_MODELS,
          },
        },
      },
    });
  });

  it("preserves apiKey, headers, and unknown provider fields while repairing managed fields", () => {
    const config = {
      models: {
        providers: {
          deepseek: {
            baseUrl: "https://api.deepseek.com/v1",
            api: "wrong-api",
            apiKey: "sk-user",
            headers: { "X-User": "yes" },
            customField: { keep: true },
            models: ["old"],
          },
        },
      },
    };

    injectDeepSeekModelsConfig(config, "http://127.0.0.1:9000/v1");

    expect(config.models.providers.deepseek).toEqual({
      baseUrl: "http://127.0.0.1:9000/v1",
      api: "openai-completions",
      apiKey: "sk-user",
      headers: { "X-User": "yes" },
      customField: { keep: true },
      models: DEEPSEEK_OPENCLAW_MODELS,
    });
  });

  it("is idempotent across repeated injection", () => {
    const config: Record<string, unknown> = {};

    injectDeepSeekModelsConfig(config, "http://127.0.0.1:8402/v1");
    injectDeepSeekModelsConfig(config, "http://127.0.0.1:8402/v1");

    const providers = (config.models as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(["deepseek"]);
    expect((providers.deepseek as { models: unknown[] }).models).toHaveLength(3);
  });
});
