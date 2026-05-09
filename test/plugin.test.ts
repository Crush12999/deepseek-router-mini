import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEEPSEEK_OPENCLAW_MODELS } from "../src/provider.js";
import {
  injectDeepSeekModelsConfig,
  localProviderBaseUrl,
  registerOpenClawPlugin,
} from "../src/plugin.js";

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

describe("OpenClaw plugin lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("DEEPSEEK_ROUTER_PORT", undefined);
    vi.stubEnv("DEEPSEEK_BASE_URL", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers provider, injects config, starts proxy, and registers a stop service", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close,
    });
    const providerCalls: unknown[] = [];
    const serviceCalls: Array<{ id: string; stop: () => Promise<void> }> = [];
    const api = {
      config: {},
      registerProvider: (provider: unknown) => providerCalls.push(provider),
      registerService: (service: { id: string; stop: () => Promise<void> }) => serviceCalls.push(service),
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
    };

    await registerOpenClawPlugin(api, { startProxy });

    expect(startProxy).toHaveBeenCalledWith({ port: 8402, baseUrl: "https://api.deepseek.com" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      id: "deepseek",
      models: { baseUrl: "http://127.0.0.1:8402/v1" },
    });
    expect(api.config).toMatchObject({
      models: {
        providers: {
          deepseek: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
          },
        },
      },
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]?.id).toBe("deepseek-router-proxy");

    await serviceCalls[0]!.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses DEEPSEEK_ROUTER_PORT and DEEPSEEK_BASE_URL when present", async () => {
    vi.stubEnv("DEEPSEEK_ROUTER_PORT", "9011");
    vi.stubEnv("DEEPSEEK_BASE_URL", "https://gateway.example.com");

    const startProxy = vi.fn().mockResolvedValue({
      port: 9011,
      baseUrl: "https://gateway.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: vi.fn(),
    };

    await registerOpenClawPlugin(api, { startProxy });

    expect(startProxy).toHaveBeenCalledWith({
      port: 9011,
      baseUrl: "https://gateway.example.com",
    });
    expect(api.registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({
          baseUrl: "http://127.0.0.1:9011/v1",
        }),
      }),
    );
  });

  it("logs and rethrows proxy startup errors so OpenClaw can surface them", async () => {
    const error = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8402");
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: vi.fn(),
      logger: {
        error: vi.fn(),
      },
    };

    await expect(
      registerOpenClawPlugin(api, {
        startProxy: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow("EADDRINUSE");
    expect(api.logger.error).toHaveBeenCalledWith(
      "DeepSeek Router Mini failed to start on port 8402: listen EADDRINUSE: address already in use 127.0.0.1:8402",
    );
  });
});
