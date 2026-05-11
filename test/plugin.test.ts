import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { XIAOYI_OPENCLAW_MODELS } from "../src/provider.js";
import type { OpenClawService } from "../src/plugin.js";
import {
  injectXiaoyiModelsConfig,
  localProviderBaseUrl,
  registerOpenClawPlugin,
} from "../src/plugin.js";

describe("OpenClaw plugin config injection", () => {
  it("builds the local provider baseUrl from the configured port", () => {
    expect(localProviderBaseUrl(8402)).toBe("http://127.0.0.1:8402/v1");
  });

  it("creates missing models.providers.xiaoyiprovider without inventing an apiKey", () => {
    const config: Record<string, unknown> = {};

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1");

    expect(config).toEqual({
      models: {
        providers: {
          xiaoyiprovider: {
            baseUrl: "http://127.0.0.1:8402/v1",
            api: "openai-completions",
            models: XIAOYI_OPENCLAW_MODELS,
          },
        },
      },
    });
    const provider = (config.models as { providers: Record<string, Record<string, unknown>> }).providers.xiaoyiprovider;
    expect(provider).not.toHaveProperty("apiKey");
  });

  it("preserves user provider fields while repairing managed fields", () => {
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

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:9000/v1");

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
      models: XIAOYI_OPENCLAW_MODELS,
    });
  });

  it.each([
    ["string", "broken"],
    ["null", null],
    ["array", ["broken"]],
  ])("replaces non-object xiaoyiprovider config (%s) with managed provider config", (_caseName, value) => {
    const config = {
      models: {
        providers: {
          xiaoyiprovider: value,
        },
      },
    };

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1");

    expect(config.models.providers.xiaoyiprovider).toEqual({
      baseUrl: "http://127.0.0.1:8402/v1",
      api: "openai-completions",
      models: XIAOYI_OPENCLAW_MODELS,
    });
  });

  it("is idempotent across repeated injection", () => {
    const config: Record<string, unknown> = {};

    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1");
    injectXiaoyiModelsConfig(config, "http://127.0.0.1:8402/v1");

    const providers = (config.models as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers)).toEqual(["xiaoyiprovider"]);
    expect(((providers.xiaoyiprovider) as { models: unknown[] }).models).toHaveLength(3);
  });
});

describe("OpenClaw plugin lifecycle", () => {
  const serviceCalls: OpenClawService[] = [];

  beforeEach(() => {
    serviceCalls.length = 0;
    vi.stubEnv("XIAOYI_ROUTER_PORT", undefined);
    vi.stubEnv("XIAOYI_BASE_URL", undefined);
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(serviceCalls.map((service) => service.stop()));
    } finally {
      vi.unstubAllEnvs();
    }
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
      registerProvider: (provider: unknown) => providerCalls.push(provider),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
      logger: {
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
    expect(startProxy).toHaveBeenCalledWith({ port: 8402, baseUrl: "https://api.deepseek.com" });
    expect(api.logger.info).toHaveBeenCalledWith(
      "Xiaoyi Router listening on http://127.0.0.1:8402/v1",
    );

    await serviceCalls[0]!.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses XIAOYI_ROUTER_PORT and XIAOYI_BASE_URL when present", async () => {
    vi.stubEnv("XIAOYI_ROUTER_PORT", "9011");
    vi.stubEnv("XIAOYI_BASE_URL", "https://gateway.example.com");

    const startProxy = vi.fn().mockResolvedValue({
      port: 9011,
      baseUrl: "https://gateway.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      registerProvider: vi.fn(),
      registerService: (service: OpenClawService) => serviceCalls.push(service),
    };

    registerOpenClawPlugin(api, { startProxy });

    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(startProxy).not.toHaveBeenCalled();

    await serviceCalls[0]!.start();
    expect(startProxy).toHaveBeenCalledWith({
      port: 9011,
      baseUrl: "https://gateway.example.com",
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
    expect(startProxy).toHaveBeenCalledWith({ port: 9999, baseUrl: "https://plugin.example.com" });
  });

  it.each(["runtime", "full"])(
    "does not require registerProvider on the OpenClaw API in %s mode",
    (registrationMode) => {
      const startProxy = vi.fn();
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
              models: XIAOYI_OPENCLAW_MODELS,
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
    expect(startProxy).toHaveBeenCalledWith({
      port: 8402,
      baseUrl: "https://gateway.example.com/v4",
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

    expect(startProxy).toHaveBeenCalledWith({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      apiKey: "config-key",
      headers: {
        "X-Provider": "yes",
        "X-Override": "request",
        "X-Request": "yes",
      },
    });
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

    expect(startProxy).toHaveBeenCalledWith({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      apiKey: "camel-key",
    });
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

    expect(startProxy).toHaveBeenCalledWith({
      port: 8402,
      baseUrl: "https://api.deepseek.com",
      headers: {
        authorization: "Bearer request-token",
        "x-uid": "request-user",
        "x-provider-only": "yes",
        "x-request-only": "yes",
      },
    });
  });

  it("prefers pluginConfig over environment variables", async () => {
    vi.stubEnv("XIAOYI_ROUTER_PORT", "9011");
    vi.stubEnv("XIAOYI_BASE_URL", "https://env.example.com");

    const startProxy = vi.fn().mockResolvedValue({
      port: 9999,
      baseUrl: "https://plugin.example.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
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
    expect(startProxy).toHaveBeenCalledWith({ port: 9999, baseUrl: "https://plugin.example.com" });
  });

  it("falls back to env/default when pluginConfig port is invalid", async () => {
    vi.stubEnv("XIAOYI_ROUTER_PORT", "9011");

    const startProxy = vi.fn().mockResolvedValue({
      port: 9011,
      baseUrl: "https://api.deepseek.com",
      close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    });
    const api = {
      config: {},
      pluginConfig: {
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
            baseUrl: "http://127.0.0.1:9011/v1",
          },
        },
      },
    });

    await serviceCalls[0]!.start();
    expect(startProxy).toHaveBeenCalledWith({ port: 9011, baseUrl: "https://api.deepseek.com" });
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
    expect(mod.XIAOYI_OPENCLAW_MODELS).toHaveLength(3);
  });

  it("returns synchronously from default register and only registers a runtime service", async () => {
    const mod = await import("../src/index.js");
    const services: OpenClawService[] = [];
    const api = {
      config: {},
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
