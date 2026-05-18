import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

import type { RawConfig } from "../src/config-schema.js";
import { generateOpenClawModels } from "../src/provider.js";
import type { OpenClawService } from "../src/plugin.js";
import {
  injectXiaoyiModelsConfig,
  localProviderBaseUrl,
  registerOpenClawPlugin as registerOpenClawPluginImpl,
} from "../src/plugin.js";

function createPluginConfig(port = 8402, upstreamUrl = "https://api.deepseek.com"): RawConfig {
  return {
    version: 1,
    proxy: { port, upstreamUrl, trace: "off" as const },
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
        kind: "router" as const,
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
      flash: {
        kind: "alias" as const,
        candidates: ["deepseek-v4-flash"],
        selection: "first" as const,
      },
      pro: {
        kind: "alias" as const,
        candidates: ["deepseek-v4-pro"],
        selection: "first" as const,
      },
    },
    routing: {
      tiers: {
        SIMPLE: { publicModel: "flash" },
        MEDIUM: { publicModel: "flash", fallback: ["pro"] },
        COMPLEX: { publicModel: "pro" },
        REASONING: { publicModel: "pro" },
      },
      structuredOutputMinTier: "MEDIUM" as const,
      ambiguousDefaultTier: "MEDIUM" as const,
    },
  };
}

function createInjectedModels(config: RawConfig) {
  return generateOpenClawModels(config.publicModels, config.models);
}

function onlyAutoModel(models: ReturnType<typeof createInjectedModels>) {
  return models.filter((model) => model.id === "auto");
}

const fixtureConfigPath = path.resolve(__dirname, "fixtures/minimal-config.json");

function normalizePluginConfig(
  pluginConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!pluginConfig) {
    return { config: createPluginConfig() };
  }

  if ("config" in pluginConfig || "configPath" in pluginConfig) {
    return pluginConfig;
  }

  return {
    config: createPluginConfig(),
    ...pluginConfig,
  };
}

function registerOpenClawPlugin(
  api: {
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    registrationMode?: string;
    registerProvider?: (provider: unknown) => void;
    registerService: (service: OpenClawService) => void;
    logger?: {
      debug?: (message: string) => void;
      info?: (message: string) => void;
      error?: (message: string) => void;
    };
  },
  runtime?: Parameters<typeof registerOpenClawPluginImpl>[1],
): void {
  registerOpenClawPluginImpl(
    {
      ...api,
      pluginConfig: normalizePluginConfig(api.pluginConfig),
    },
    runtime,
  );
}

function registerOpenClawPluginWithoutDefaults(
  api: {
    config: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    registrationMode?: string;
    registerProvider?: (provider: unknown) => void;
    registerService: (service: OpenClawService) => void;
    logger?: {
      debug?: (message: string) => void;
      info?: (message: string) => void;
      error?: (message: string) => void;
    };
  },
  runtime?: Parameters<typeof registerOpenClawPluginImpl>[1],
): void {
  registerOpenClawPluginImpl(api, runtime);
}

function expectStartProxyRuntimeCall(
  startProxy: ReturnType<typeof vi.fn>,
  expectedProxy: Partial<RawConfig["proxy"]>,
): void {
  expect(startProxy).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining(expectedProxy),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }),
  );
}

describe("OpenClaw plugin config injection", () => {
  it("builds the local provider baseUrl from the configured port", () => {
    expect(localProviderBaseUrl(8402)).toBe("http://127.0.0.1:8402/v1");
  });

  it("creates missing models.providers.xiaoyiprovider without inventing an apiKey", () => {
    const config: Record<string, unknown> = {};
    const runtimeConfig = createPluginConfig();
    const models = createInjectedModels(runtimeConfig);
    const injectedModels = onlyAutoModel(models);

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1", models);

    expect(config).toEqual({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
            models: injectedModels,
          },
        },
      },
    });
    const provider = (config.models as { providers: Record<string, Record<string, unknown>> }).providers.xiaoyiprovider;
    expect(provider).not.toHaveProperty("apiKey");
  });

  it("preserves user provider fields while repairing managed fields", () => {
    const runtimeConfig = createPluginConfig();
    const models = createInjectedModels(runtimeConfig);
    const injectedModels = onlyAutoModel(models);
    const config = {
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "https://api.deepseek.com/v1",
            api: "wrong-api",
            apiKey: "sk-user",
            api_key: "sk-user-snake",
            headers: { "X-User": "yes" },
            request: {
              headers: { "X-Request": "yes" },
              timeout: 30_000,
            },
            metadata: { owner: "user" },
            extra: ["keep", "me"],
            models: ["old"],
          },
        },
      },
    };

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:9000/v1", models);

    expect(config.models.providers.xiaoyiprovider).toEqual({
      baseUrl: "http://127.0.0.1:9000/v1",
      api: "openai-completions",
      apiKey: "sk-user",
      api_key: "sk-user-snake",
      headers: { "X-User": "yes" },
      request: {
        headers: { "X-Request": "yes" },
        timeout: 30_000,
      },
      metadata: { owner: "user" },
      extra: ["keep", "me"],
      models: injectedModels,
    });
  });

  it.each([
    ["string", "broken"],
    ["null", null],
    ["array", ["broken"]],
  ])("replaces non-object xiaoyiprovider config (%s) with managed provider config", (_caseName, value) => {
    const runtimeConfig = createPluginConfig();
    const models = createInjectedModels(runtimeConfig);
    const injectedModels = onlyAutoModel(models);
    const config = {
      models: {
        providers: {
          xiaoyiprovider: value,
        },
      },
    };

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1", models);

    expect(config.models.providers.xiaoyiprovider).toEqual({
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      models: injectedModels,
    });
  });

  it("injects models generated from runtime config instead of a static catalog", () => {
    const runtimeConfig = createPluginConfig();
    const autoModel = runtimeConfig.publicModels.auto;
    const flashModel = runtimeConfig.publicModels.flash;
    if (autoModel.kind !== "router" || flashModel.kind !== "alias") {
      throw new Error("unexpected public model config in test fixture");
    }

    autoModel.metadata.cost = {
      input: 1.23,
      output: 4.56,
      cacheRead: 0.31,
      cacheWrite: 1.23,
    };
    autoModel.metadata.maxTokens = 12_345;
    flashModel.metadata = {
      name: "Flash Alias Override",
      reasoning: false,
      contextWindow: 222_222,
      maxTokens: 3_333,
      cost: {
        input: 9.87,
        output: 6.54,
        cacheRead: 2.46,
        cacheWrite: 9.87,
      },
    };
    const models = createInjectedModels(runtimeConfig);
    const injectedModels = onlyAutoModel(models);
    const config: Record<string, unknown> = {};

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1", models);

    expect((config.models as { providers: Record<string, { models: unknown }> }).providers.xiaoyiprovider.models).toEqual(
      injectedModels,
    );
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auto",
          cost: {
            input: 1.23,
            output: 4.56,
            cacheRead: 0.31,
            cacheWrite: 1.23,
          },
          maxTokens: 12_345,
        }),
        expect.objectContaining({
          id: "flash",
          name: "Flash Alias Override",
          reasoning: false,
          cost: {
            input: 9.87,
            output: 6.54,
            cacheRead: 2.46,
            cacheWrite: 9.87,
          },
          contextWindow: 222_222,
          maxTokens: 3_333,
        }),
      ]),
    );
    expect(injectedModels).toEqual([
      expect.objectContaining({
        id: "auto",
        cost: {
          input: 1.23,
          output: 4.56,
          cacheRead: 0.31,
          cacheWrite: 1.23,
        },
        maxTokens: 12_345,
      }),
    ]);
  });

  it("is idempotent across repeated injection", () => {
    const config: Record<string, unknown> = {};
    const runtimeConfig = createPluginConfig();
    const models = createInjectedModels(runtimeConfig);
    const injectedModels = onlyAutoModel(models);

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1", models);
    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1", models);

    const providers = (config.models as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(["xiaoyiprovider"]);
    expect(((providers.xiaoyiprovider) as { models: unknown[] }).models).toEqual(injectedModels);
  });
});

describe("OpenClaw plugin lifecycle", () => {
  const serviceCalls: OpenClawService[] = [];

  beforeEach(() => {
    serviceCalls.length = 0;
  });

  afterEach(async () => {
    await Promise.allSettled(serviceCalls.map((service) => service.stop()));
  });

  it("registers synchronously and starts the proxy only when the service starts", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close,
    });
    const providerCalls: unknown[] = [];
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(),
      },
      registerProvider: (provider: unknown) => providerCalls.push(provider),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
    };

    const result = registerOpenClawPlugin(api, { startProxy });

    expect(result).toBeUndefined();
    expect(startProxy).not.toHaveBeenCalled();
    expect(providerCalls).toHaveLength(0);
    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
          },
        },
      },
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0]).toMatchObject({
      id: "xiaoyi-router-proxy",
      start: expect.any(Function),
      stop: expect.any(Function),
    });

    await serviceCalls[0]!.start();
    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          port: 8402,
          upstreamUrl: "https://api.deepseek.com",
        }),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }));
    expect(api.logger.info).toHaveBeenCalledWith(
      "Xiaoyi Router listening on http://127.0.0.1:8402/v1",
    );

    await serviceCalls[0]!.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses config from pluginConfig when no port/upstreamUrl overrides", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 9011,
      baseUrl: "https://gateway.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(9011, "https://gateway.example.com"),
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(startProxy).not.toHaveBeenCalled();

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 9011,
      upstreamUrl: "https://gateway.example.com",
    });
  });

  it("uses pluginConfig port and upstreamUrl for runtime and local provider config", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 9999,
      baseUrl: "https://plugin.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        port: 9999,
        upstreamUrl: "https://plugin.example.com",
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:9999/v1",
            api: "openai-completions",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 9999,
      upstreamUrl: "https://plugin.example.com",
    });
  });

  it.each(["runtime", "full"])(
    "does not require registerProvider on the OpenClaw API in %s mode",
    (registrationMode) => {
      const startProxy = vi.fn();
      const runtimeConfig = createPluginConfig();
      const models = createInjectedModels(runtimeConfig);
      const injectedModels = onlyAutoModel(models);
      const api = {
        config: {},
        registrationMode,
        registerService: (service: OpenClawService) => serviceCalls.push(service),
      };

      const result = registerOpenClawPlugin(api, { startProxy });

      expect(result).toBeUndefined();
      expect(startProxy).not.toHaveBeenCalled();
      expect(api.config).toMatchObject({
        models: {
          providers: {
            xiaoyiprovider: {
              baseUrl: "http://127.0.0.1:8402/v1",
              api: "openai-completions",
              models: injectedModels,
            },
          },
        },
      });
      expect(serviceCalls).toHaveLength(1);
      expect(serviceCalls[0]).toMatchObject({
        id: "xiaoyi-router-proxy",
        start: expect.any(Function),
        stop: expect.any(Function),
      });
    },
  );

  it("keeps local provider baseUrl separate from versioned pluginConfig upstreamUrl", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://gateway.example.com/v4",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        upstreamUrl: "https://gateway.example.com/v4",
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 8402,
      upstreamUrl: "https://gateway.example.com/v4",
    });
  });

  it("passes OpenClaw provider apiKey and headers through to the proxy runtime", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {
        models: {
          providers: {
            xiaoyiprovider: {
              api_key: "config-key",
              headers: {
                "X-Provider": "yes",
                "X-Override": "provider",
                "X-Ignored": 123,
              },
              request: {
                headers: {
                  "X-Override": "request",
                  "X-Request": "yes",
                },
              },
            },
          },
        },
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          port: 8402,
          upstreamUrl: "https://api.deepseek.com",
          apiKey: "config-key",
          headers: {
            "X-Provider": "yes",
            "X-Override": "request",
            "X-Request": "yes",
          },
        }),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }));
  });

  it("re-reads provider runtime overrides when the host updates config before first start", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {
        models: {
          providers: {
            xiaoyiprovider: {
              apiKey: "stale-key",
              headers: {
                "X-Provider": "stale",
              },
            },
          },
        },
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    api.config.models.providers.xiaoyiprovider.apiKey = "fresh-key";
    const freshHeaders: Record<string, string> = {
      "X-Provider": "fresh",
      "X-New": "before-first-start",
    };
    (
      api.config.models.providers.xiaoyiprovider as {
        apiKey?: string;
        headers?: Record<string, string>;
      }
    ).headers = freshHeaders;

    await serviceCalls[0]!.start();

    expectStartProxyRuntimeCall(startProxy, {
      port: 8402,
      upstreamUrl: "https://api.deepseek.com",
      apiKey: "fresh-key",
      headers: {
        "X-Provider": "fresh",
        "X-New": "before-first-start",
      },
    });
  });

  it("re-reads provider runtime overrides on every start after stop", async () => {
    const firstClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const secondClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi
      .fn()
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: firstClose,
      })
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: secondClose,
      });
    const api = {
      config: {
        models: {
          providers: {
            xiaoyiprovider: {
              apiKey: "initial-key",
              headers: {
                "X-Provider": "initial",
              },
            },
          },
        },
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      apiKey: "initial-key",
      headers: {
        "X-Provider": "initial",
      },
    });

    await serviceCalls[0]!.stop();

    api.config.models.providers.xiaoyiprovider.apiKey = "next-key";
    const nextHeaders: Record<string, string> = {
      "X-Provider": "next",
      "X-After-Stop": "yes",
    };
    (
      api.config.models.providers.xiaoyiprovider as {
        apiKey?: string;
        headers?: Record<string, string>;
      }
    ).headers = nextHeaders;

    await serviceCalls[0]!.start();

    expect(startProxy).toHaveBeenCalledTimes(2);
    expect(startProxy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          apiKey: "next-key",
          headers: {
            "X-Provider": "next",
            "X-After-Stop": "yes",
          },
        }),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }));
  });

  it("prefers provider apiKey over api_key for proxy runtime", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {
        models: {
          providers: {
            xiaoyiprovider: {
              apiKey: "camel-key",
              api_key: "snake-key",
            },
          },
        },
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          port: 8402,
          upstreamUrl: "https://api.deepseek.com",
          apiKey: "camel-key",
        }),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }));
  });

  it("passes provider request headers over provider headers for proxy runtime", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {
        models: {
          providers: {
            xiaoyiprovider: {
              headers: {
                Authorization: "Bearer provider-token",
                "x-uid": "provider-user",
                "x-provider-only": "yes",
              },
              request: {
                headers: {
                  authorization: "Bearer request-token",
                  "x-uid": "request-user",
                  "x-request-only": "yes",
                },
              },
            },
          },
        },
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          port: 8402,
          upstreamUrl: "https://api.deepseek.com",
          headers: {
            authorization: "Bearer request-token",
            "x-uid": "request-user",
            "x-provider-only": "yes",
            "x-request-only": "yes",
          },
        }),
      }),
      traceLogger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
      }),
    }));
  });

  it("prefers pluginConfig port/upstreamUrl overrides over config file values", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 9999,
      baseUrl: "https://plugin.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(),
        port: "9999",
        upstreamUrl: "https://plugin.example.com",
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:9999/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 9999,
      upstreamUrl: "https://plugin.example.com",
    });
  });

  it("falls back to config port when pluginConfig port override is invalid", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(),
        port: "nope",
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 8402,
      upstreamUrl: "https://api.deepseek.com",
    });
  });

  it.each(["discovery", "cli-metadata", "setup-only", "tool-discovery"])(
    "only injects config in %s mode",
    (registrationMode) => {
      const startProxy = vi.fn();
      const api = {
        config: {},
        registrationMode,
        pluginConfig: {
          port: 9999,
          upstreamUrl: "https://plugin.example.com",
        },
        registerProvider: vi.fn(),
        registerService: vi.fn(),
      };

      registerOpenClawPlugin(api, { startProxy });

      expect(startProxy).not.toHaveBeenCalled();
      expect(api.registerService).not.toHaveBeenCalled();
      expect(api.registerProvider).not.toHaveBeenCalled();
      expect(api.config).toMatchObject({
        models: {
          providers: {
            xiaoyiprovider: {
              baseUrl: "http://127.0.0.1:9999/v1",
              api: "openai-completions",
            },
          },
        },
      });
    },
  );

  it("closes the previous proxy when a later service starts", async () => {
    const firstClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const secondClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi
      .fn()
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: firstClose,
      })
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: secondClose,
      });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();
    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[1]!.start();

    expect(firstClose).toHaveBeenCalledTimes(1);

    await serviceCalls[1]!.stop();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("does not let an old service stop close a later proxy", async () => {
    const firstClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const secondClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi
      .fn()
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: firstClose,
      })
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: secondClose,
      });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    const firstService = serviceCalls[0]!;
    await firstService.start();
    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[1]!.start();

    await firstService.stop();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();

    await serviceCalls[1]!.stop();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("does not register provider or mutate config when service registration fails", () => {
    const registerError = new Error("duplicate service id");
    const startProxy = vi.fn();
    const config = { models: { providers: { keep: { baseUrl: "https://keep.example.com" } } } };
    const api = {
      config,
      registerProvider: vi.fn(),
      registerService: vi.fn(() => {
        throw registerError;
      }),
    };

    expect(() => registerOpenClawPlugin(api, { startProxy })).toThrow(registerError);
    expect(startProxy).not.toHaveBeenCalled();
    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.config).toEqual({
      models: {
        providers: {
          keep: { baseUrl: "https://keep.example.com" },
        },
      },
    });
  });

  it("runs the underlying proxy close once for concurrent stop calls", async () => {
    const closeResolvers: Array<() => void> = [];
    const closeStarted = vi.fn();
    const close = vi.fn<() => Promise<void>>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          closeStarted();
          closeResolvers.push(resolve);
        }),
    );
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close,
    });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    const firstStop = serviceCalls[0]!.stop();
    const secondStop = serviceCalls[0]!.stop();

    expect(closeStarted).toHaveBeenCalled();

    closeResolvers.forEach((resolve) => resolve());
    await expect(Promise.all([firstStop, secondStop])).resolves.toEqual([undefined, undefined]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shares the same rejection for concurrent stop calls when close fails", async () => {
    const closeError = new Error("failed to close proxy");
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(closeError)
      .mockRejectedValueOnce(closeError)
      .mockResolvedValue(undefined);
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close,
    });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    const firstStop = serviceCalls[0]!.stop();
    const secondStop = serviceCalls[0]!.stop();
    const results = await Promise.allSettled([firstStop, secondStop]);

    expect(results).toEqual([
      { status: "rejected", reason: closeError },
      { status: "rejected", reason: closeError },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not start a replacement proxy when closing the active proxy fails", async () => {
    const closeError = new Error("failed to close old proxy");
    const firstClose = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(closeError)
      .mockResolvedValueOnce(undefined);
    const secondClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const startProxy = vi
      .fn()
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: firstClose,
      })
      .mockResolvedValueOnce({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: secondClose,
      });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
      logger: {
        error: vi.fn(),
      },
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();
    registerOpenClawPlugin(api, { startProxy });

    await expect(serviceCalls[1]!.start()).rejects.toThrow(closeError);
    expect(startProxy).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledTimes(1);

    await serviceCalls[0]!.stop();
    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[2]!.start();

    expect(startProxy).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(2);

    await serviceCalls[2]!.stop();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("logs and rethrows proxy startup errors so OpenClaw can surface them", async () => {
    const error = new Error("listen EADDRINUSE: address already in use 127.0.0.1:8402");
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
      logger: {
        error: vi.fn(),
      },
    };

    registerOpenClawPlugin(api, {
      startProxy: vi.fn().mockRejectedValue(error),
    });

    await expect(serviceCalls[0]!.start()).rejects.toThrow("EADDRINUSE");
    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
          },
        },
      },
    });
    expect(api.logger.error).toHaveBeenCalledWith(
      "Xiaoyi Router failed to start on port 8402: listen EADDRINUSE: address already in use 127.0.0.1:8402",
    );
  });

  it("falls back to info when the plugin logger has no debug method", async () => {
    const info = vi.fn();
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
      logger: {
        info,
      },
    };

    registerOpenClawPlugin(api, { startProxy });
    await serviceCalls[0]!.start();

    const traceLogger = startProxy.mock.calls[0]?.[0].traceLogger as {
      debug: (message: string) => void;
      info: (message: string) => void;
    };

    traceLogger.debug("trace debug fallback");
    traceLogger.info("trace info");

    expect(info).toHaveBeenCalledWith("trace debug fallback");
    expect(info).toHaveBeenCalledWith("trace info");
  });
});

describe("OpenClaw plugin config-driven loading", () => {
  const serviceCalls: OpenClawService[] = [];

  beforeEach(() => {
    serviceCalls.length = 0;
  });

  afterEach(async () => {
    await Promise.allSettled(serviceCalls.map((service) => service.stop()));
  });

  it("loads config from pluginConfig.config (inline)", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 9000,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(9000, "https://api.deepseek.com"),
      },
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:9000/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 9000,
      upstreamUrl: "https://api.deepseek.com",
    });
  });

  it("loads config from pluginConfig.configPath (file)", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        configPath: fixtureConfigPath,
      },
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expect(startProxy).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        proxy: expect.objectContaining({
          port: 8402,
          upstreamUrl: "https://api.deepseek.com",
        }),
      }),
    }));
  });

  it("throws error when plugin config is missing", () => {
    const startProxy = vi.fn();
    const api = {
      config: {},
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    expect(() => registerOpenClawPluginWithoutDefaults(api, { startProxy })).toThrow(
      "xiaoyi-router: missing config. Set pluginConfig.config or pluginConfig.configPath"
    );
  });

  it("allows pluginConfig.port to override config file port", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 9999,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        configPath: fixtureConfigPath,
        port: 9999
      },
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:9999/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 9999,
      upstreamUrl: "https://api.deepseek.com",
    });
  });

  it("allows pluginConfig.upstreamUrl to override config file upstreamUrl", async () => {
    const startProxy = vi.fn().mockResolvedValue({
      port: 8402,
      baseUrl: "https://override.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
        configPath: fixtureConfigPath,
        upstreamUrl: "https://override.example.com"
      },
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    await serviceCalls[0]!.start();
    expectStartProxyRuntimeCall(startProxy, {
      port: 8402,
      upstreamUrl: "https://override.example.com",
    });
  });
});

describe("OpenClaw plugin default export", () => {
  it("exports the plugin object from the source entrypoint", async () => {
    const mod = await import("../src/index.js");

    expect(mod.default).toMatchObject({
      id: "xiaoyi-router",
      name: "Xiaoyi Router",
      description: "Xiaoyi local routing proxy for OpenClaw",
    });
    expect(mod.default.version).toBe(mod.VERSION);
    expect(typeof mod.default.register).toBe("function");
    expect(typeof mod.startProxy).toBe("function");
  });

  it("returns synchronously from default register and only registers a runtime service", async () => {
    const mod = await import("../src/index.js");
    const services: OpenClawService[] = [];
    const api = {
      config: {},
      pluginConfig: {
        config: createPluginConfig(),
      },
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => services.push(service),
    };

    const result = mod.default.register(api);

    expect(result).toBeUndefined();
    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(api.config).toMatchObject({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
          },
        },
      },
    });
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({
      id: "xiaoyi-router-proxy",
      start: expect.any(Function),
      stop: expect.any(Function),
    });
  });
});
