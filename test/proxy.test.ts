import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawConfig } from "../src/config-schema.js";
import { startProxy as startProxyImpl } from "../src/proxy.js";
import type { ProxyOptions } from "../src/proxy.js";
import { SessionStore } from "../src/session.js";

const routerHeader = (name: string) => ["x", "xy", "router", name].join("-");

type CapturedRequest = {
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function startUpstream(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : undefined;
        } catch {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        requests.push({
          url: req.url ?? "",
          headers: req.headers,
          body: parsed,
        });

        if (handler) {
          handler(req, res);
          return;
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cmpl_1", choices: [{ message: { content: "ok" } }] }));
      } catch {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Bad Request" }));
        } else {
          res.destroy();
        }
      }
    })();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("bad address"));
      else resolve(address.port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const realFetch = globalThis.fetch.bind(globalThis);

async function request(port: number, path: string, init: RequestInit = {}) {
  return realFetch(`http://127.0.0.1:${port}${path}`, init);
}

const handles: Array<{ close: () => Promise<void> }> = [];

function requestedModels(requests: CapturedRequest[]): string[] {
  return requests.map((entry) => (entry.body as { model: string }).model);
}

async function withCleanAuthEnv<T>(callback: () => Promise<T>): Promise<T> {
  const originalApiKey = process.env.XIAOYI_API_KEY;
  const originalHeaders = process.env.XIAOYI_ROUTER_HEADERS;
  delete process.env.XIAOYI_API_KEY;
  delete process.env.XIAOYI_ROUTER_HEADERS;

  try {
    return await callback();
  } finally {
    if (originalApiKey === undefined) delete process.env.XIAOYI_API_KEY;
    else process.env.XIAOYI_API_KEY = originalApiKey;

    if (originalHeaders === undefined) delete process.env.XIAOYI_ROUTER_HEADERS;
    else process.env.XIAOYI_ROUTER_HEADERS = originalHeaders;
  }
}

type ProxyRuntimeLimitTestOptions = NonNullable<ProxyOptions["runtimeLimits"]>;

function createAliasConfig(): RawConfig {
  return {
    version: 1,
    proxy: {
      port: 8402,
      upstreamUrl: "https://api.deepseek.com",
      trace: "debug",
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
      "deepseek-v4-flash": {
        kind: "alias",
        candidates: ["deepseek-v4-flash"],
        selection: "first",
      },
      "deepseek-v4-pro": {
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
    },
  };
}

function createConfigDrivenAliasTierConfig(): RawConfig {
  const config = createAliasConfig();
  return {
    ...config,
    publicModels: {
      ...config.publicModels,
      lite: {
        kind: "alias",
        candidates: ["deepseek-v4-flash"],
        selection: "first",
      },
      think: {
        kind: "alias",
        candidates: ["deepseek-v4-pro"],
        selection: "first",
      },
    },
    routing: {
      ...config.routing,
      tiers: {
        SIMPLE: { publicModel: "lite" },
        MEDIUM: { publicModel: "flash", fallback: ["lite", "pro"] },
        COMPLEX: { publicModel: "pro" },
        REASONING: { publicModel: "think" },
      },
    },
  };
}

function createSwiftThinkConfig(): RawConfig {
  const config = createAliasConfig();
  return {
    ...config,
    publicModels: {
      auto: config.publicModels.auto,
      swift: {
        kind: "alias",
        candidates: ["deepseek-v4-flash"],
        selection: "first",
      },
      think: {
        kind: "alias",
        candidates: ["deepseek-v4-pro"],
        selection: "first",
      },
    },
    routing: {
      ...config.routing,
      tiers: {
        SIMPLE: { publicModel: "swift" },
        MEDIUM: { publicModel: "swift", fallback: ["think"] },
        COMPLEX: { publicModel: "think" },
        REASONING: { publicModel: "think" },
      },
    },
  };
}

function withProxyOverrides(
  config: RawConfig,
  overrides: Partial<RawConfig["proxy"]> = {},
): RawConfig {
  return {
    ...config,
    proxy: {
      ...config.proxy,
      ...overrides,
    },
  };
}

async function startProxy(
  options: {
    baseUrl?: string;
    port?: number;
    apiKey?: string;
    headers?: Record<string, string>;
    traceMode?: "off" | "summary" | "debug";
    traceLogger?: ProxyOptions["traceLogger"];
    session?: ProxyOptions["session"];
    runtimeLimits?: ProxyRuntimeLimitTestOptions;
    config?: RawConfig;
  },
) {
  if (options.config) {
    const config = withProxyOverrides(options.config, {
      upstreamUrl: options.baseUrl ?? options.config.proxy.upstreamUrl,
      port: options.port ?? options.config.proxy.port,
      apiKey: options.apiKey ?? options.config.proxy.apiKey,
      headers: options.headers ?? options.config.proxy.headers,
      trace: options.traceMode ?? options.config.proxy.trace,
    });

    const proxyOptions: ProxyOptions = {
      config,
      traceLogger: options.traceLogger,
      session: options.session,
      runtimeLimits: options.runtimeLimits,
    };

    return startProxyImpl(proxyOptions);
  }

  const proxyOptions: ProxyOptions = {
    config: withProxyOverrides(createAliasConfig(), {
      upstreamUrl: options.baseUrl,
      port: options.port,
      apiKey: options.apiKey,
      headers: options.headers,
      trace: options.traceMode,
    }),
    traceLogger: options.traceLogger,
    session: options.session,
    runtimeLimits: options.runtimeLimits,
  };

  return startProxyImpl(proxyOptions);
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (handles.length) {
    await handles.pop()?.close();
  }
});

describe("proxy", () => {
  it("closes the session store when the proxy closes", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const closeSpy = vi.spyOn(SessionStore.prototype, "close");
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });

    await proxy.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("serves health and does not serve models", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    expect(await (await request(proxy.port, "/health")).json()).toMatchObject({
      status: "ok",
      baseUrl: upstream.baseUrl,
    });
    const res = await request(proxy.port, "/v1/models");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Not Found",
        type: "invalid_request_error",
        code: null,
      },
    });
  });

  it("rejects unsupported models", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      config: withProxyOverrides(createAliasConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", messages: [] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        message: 'Unknown model "openai/gpt-5.5". Supported models: auto',
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
  });

  it("rejects hidden alias models and only advertises auto as supported", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      config: withProxyOverrides(createAliasConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    for (const model of ["flash", "pro"]) {
      const res = await request(proxy.port, "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [] }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: {
          message: `Unknown model "${model}". Supported models: auto`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
    }

    expect(upstream.requests).toHaveLength(0);
  });

  it("routes auto to a public alias while sending the physical model upstream", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      config: withProxyOverrides(createAliasConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(res.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("forwards auto requests with auth", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, apiKey: "secret" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(res.headers.get(routerHeader("routed"))).toBe("true");
    expect(res.headers.get(routerHeader("fallback"))).toBe("false");
    expect(res.headers.get(routerHeader("upstream"))).toBe(upstream.baseUrl);
    expect(upstream.requests[0]?.url).toBe("/chat/completions");
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer secret");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("does not send authorization when apiKey and authorization headers are absent", async () => {
    await withCleanAuthEnv(async () => {
      const upstream = await startUpstream();
      handles.push(upstream);
      const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
      handles.push(proxy);

      const res = await request(proxy.port, "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(res.status).toBe(200);
      expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
    });
  });

  it("keeps request authorization instead of overriding it with apiKey", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, apiKey: "secret" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer request-token",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer request-token");
  });

  it("lets configured authorization override request authorization and apiKey", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      apiKey: "secret",
      headers: { Authorization: "Bearer configured-token" },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer request-token",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer configured-token");
  });

  it("forwards to an upstream v1 API base without changing the local route", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: `${upstream.baseUrl}/v1`, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.url).toBe("/v1/chat/completions");
  });

  it("forwards to an upstream v4 API base without changing the local route", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: `${upstream.baseUrl}/v4`, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.url).toBe("/v4/chat/completions");
  });

  it("routes default auto requests to flash with tier and trace headers", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(res.headers.get(routerHeader("tier"))).toBe("SIMPLE");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:simple:flash:first-pass");
    expect(res.headers.get(routerHeader("routed"))).toBe("true");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("uses routing threshold overrides from config", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const config = createAliasConfig();
    config.routing.tierBoundaries = {
      simpleMedium: -1,
      mediumComplex: -0.5,
      complexReasoning: -0.1,
    };
    config.routing.confidenceThreshold = 0;
    const proxy = await startProxy({
      config: withProxyOverrides(config, {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("pro");
    expect(res.headers.get(routerHeader("tier"))).toBe("REASONING");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:reasoning:pro:reasoning");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-pro" });
  });

  it("does not write trace logs by default", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("writes one summary trace log when trace mode is summary", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "summary" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      "[llm-router] auto:simple:flash:first-pass model=deepseek-v4-flash fallback=false",
    );
  });

  it("writes debug trace JSON with a prompt preview but without full prompt data", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "debug" });
    handles.push(proxy);
    const routePrompt = "Compare these two API response formats and summarize the compatibility risks for a migration plan.";

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer should-not-be-logged",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "Return a strict JSON object matching the schema." },
          { role: "user", content: routePrompt },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const rawLog = String(logSpy.mock.calls[0]?.[0]);
    const logged = JSON.parse(rawLog) as Record<string, unknown>;
    expect(logged).toMatchObject({
      trace: "auto:medium:flash:first-pass",
      requestedModel: "auto",
      routedModel: "flash",
      actualModel: "deepseek-v4-flash",
      tier: "MEDIUM",
      profile: "default",
      method: "rules",
      routed: true,
      fallback: false,
      promptPreview: "Compare th...tion plan.",
    });
    expect(logged).toHaveProperty("confidence");
    expect(logged).toHaveProperty("score");
    expect(logged).toHaveProperty("agenticScore");
    expect(logged).toHaveProperty("attempts", [{ model: "deepseek-v4-flash", status: "success" }]);
    expect(rawLog).not.toContain(routePrompt);
    expect(rawLog).not.toContain("Return a strict JSON object matching the schema.");
    expect(rawLog).not.toContain("should-not-be-logged");
    expect(rawLog).not.toContain("messages");
    expect(rawLog).not.toContain("authorization");
  });

  it("records set session action when a first auto route succeeds on pro", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "debug" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "first-auto-pro-set" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: "Prove this theorem step by step and derive the result formally." },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("pro");
    const logged = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      trace: "auto:reasoning:pro:reasoning",
      routedModel: "pro",
      actualModel: "deepseek-v4-pro",
      sessionAction: "set",
    });
  });

  it("preserves public routed model and physical model when reusing a pinned session", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      traceMode: "debug",
      config: createAliasConfig(),
    });
    handles.push(proxy);
    const headers = { "content-type": "application/json", "x-session-id": "alias-reuse-pro" };

    const first = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: "Prove this theorem step by step and derive the result formally." },
        ],
      }),
    });

    expect(first.status).toBe(200);

    const second = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(second.status).toBe(200);
    expect(second.headers.get(routerHeader("trace"))).toContain(":pro:");
    const firstLogged = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    const secondLogged = JSON.parse(String(logSpy.mock.calls[1]?.[0])) as Record<string, unknown>;
    expect(firstLogged).toMatchObject({
      routedModel: "pro",
      actualModel: "deepseek-v4-pro",
      sessionAction: "set",
    });
    expect(secondLogged).toMatchObject({
      requestedModel: "auto",
      routedModel: "pro",
      actualModel: "deepseek-v4-pro",
      sessionAction: "reuse",
    });
    expect(upstream.requests).toHaveLength(2);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]);
  });

  it("routes auto requests through config-driven alias tiers without exposing alias ids publicly", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      config: withProxyOverrides(createConfigDrivenAliasTierConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const simple = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(simple.status).toBe(200);
    expect(simple.headers.get(routerHeader("model"))).toBe("lite");
    expect(simple.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-flash");
    expect(simple.headers.get(routerHeader("tier"))).toBe("SIMPLE");
    expect(simple.headers.get(routerHeader("trace"))).toBe("auto:simple:lite:first-pass");

    const reasoning = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: "Prove this theorem step by step and derive the result formally." },
        ],
      }),
    });

    expect(reasoning.status).toBe(200);
    expect(reasoning.headers.get(routerHeader("model"))).toBe("think");
    expect(reasoning.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-pro");
    expect(reasoning.headers.get(routerHeader("tier"))).toBe("REASONING");
    expect(reasoning.headers.get(routerHeader("trace"))).toBe("auto:reasoning:think:reasoning");
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("supports non-default swift/think aliases while keeping public and physical model semantics separate", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      config: withProxyOverrides(createSwiftThinkConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const routed = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(routed.status).toBe(200);
    expect(routed.headers.get(routerHeader("model"))).toBe("swift");
    expect(routed.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-flash");

    const reasoning = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: "Prove this theorem step by step and derive the result formally." },
        ],
      }),
    });

    expect(reasoning.status).toBe(200);
    expect(reasoning.headers.get(routerHeader("model"))).toBe("think");
    expect(reasoning.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-pro");
    expect(reasoning.headers.get(routerHeader("tier"))).toBe("REASONING");
    expect(reasoning.headers.get(routerHeader("trace"))).toBe("auto:reasoning:think:reasoning");
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("uses console.debug for trace logging without touching console.error", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "debug" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("routes structured output system prompts to flash when the task is ordinary", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "Return a strict JSON object matching the schema." },
          { role: "user", content: "Summarize Redis briefly." },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("keeps simple auto requests without tools on flash", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("routes by the latest user message instead of agent bootstrap text", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "assistant",
            content: "Bootstrap: use apply_patch for src/plugin.ts when editing files.",
          },
          { role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("routes by the penultimate user message when the final OpenClaw user message has no timestamp", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "user",
            content:
              "Bootstrap: debug failing tests across multiple files, find the root cause, and refactor architecture.",
          },
          {
            role: "assistant",
            content: "Intermediate assistant content proves message position is not the selector.",
          },
          { role: "user", content: "Summarize briefly: OpenClaw routes simple tasks." },
          {
            role: "user",
            content: "No timestamp tail: Prove this theorem step by step and derive the result formally.",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it.skip("routes by the final OpenClaw CLI turn inside a bootstrap-wrapped user message", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "[BEGIN BOOTSTRAP.md]\nUse apply_patch for src/plugin.ts when editing files.\n[END BOOTSTRAP.md]\n\n" +
                  "Follow the BOOTSTRAP.md instructions above now.\n\n" +
                  "[Sun 2026-05-10 01:47 GMT+8] Summarize briefly: OpenClaw routes simple tasks.",
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("lets custom authorization override api key", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      apiKey: "secret",
      headers: { Authorization: "Custom token", "X-Custom": "yes" },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers.authorization).toBe("Custom token");
    expect(upstream.requests[0]?.headers["x-custom"]).toBe("yes");
  });

  it("lets configured headers override request headers case-insensitively", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      headers: { "X-Custom": "config-value", "X-Uid": "configured-user" },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom": "incoming-value",
        "x-uid": "incoming-user",
      },
      body: JSON.stringify({ model: "auto", messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers["x-custom"]).toBe("config-value");
    expect(upstream.requests[0]?.headers["x-uid"]).toBe("configured-user");
  });

  it("does not add a duplicate content-type when custom headers use different casing", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("keeps auto sessions pinned to pro after upgrade", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "session-pro" };

    await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "user", content: "Prove this theorem step by step and derive the result formally." },
        ],
      }),
    });
    await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-pro" });
    expect(upstream.requests[1]?.body).toMatchObject({ model: "deepseek-v4-pro" });
  });

  it("does not pin an auto flash route over a later complex auto request", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "flash-then-complex" };

    const simple = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(simple.status).toBe(200);

    const complex = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        tools: [{ type: "function", function: { name: "search" } }],
        messages: [
          {
            role: "user",
            content:
              "Debug failing tests across multiple files, find the root cause, refactor the architecture, and prove step by step why the fix works.",
          },
        ],
      }),
    });

    expect(complex.status).toBe(200);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("keeps auto flash on a retryable upstream failure without falling back to pro", async () => {
    let count = 0;
    const upstream = await startUpstream((_req, res) => {
      count += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(res.headers.get(routerHeader("tier"))).toBe("SIMPLE");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:simple:flash:error");
    expect(res.headers.get(routerHeader("fallback"))).toBe("false");
    expect(count).toBe(1);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash"]);
  });

  it("keeps repeated auto tool-loop requests on flash without upgrading to pro", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "three-strike-session" };
    const body = JSON.stringify({
      model: "auto",
      tools: [{ type: "function", function: { name: "search" } }],
      messages: [{ role: "user", content: "Translate hello and check one tool result." }],
    });

    for (let i = 0; i < 4; i++) {
      const res = await request(proxy.port, "/v1/chat/completions", {
        method: "POST",
        headers,
        body,
      });
      expect(res.status).toBe(200);
    }

    expect(requestedModels(upstream.requests)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash",
    ]);
  });

  it("returns 502 on network error to upstream", async () => {
    // Point proxy to a non-existent port — fetch will throw a network error.
    const proxy = await startProxy({ baseUrl: "http://127.0.0.1:1", port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Prove this theorem step by step and derive the result formally." }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get(routerHeader("model"))).toBe("pro");
    expect(res.headers.get(routerHeader("tier"))).toBe("REASONING");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:reasoning:pro:reasoning");
    expect(res.headers.get(routerHeader("fallback"))).toBe("false");
    expect(await res.json()).toMatchObject({
      error: {
        message: expect.any(String),
        type: "invalid_request_error",
        code: null,
      },
    });
  });

  it("uses a neutral fallback message for non-Error network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("socket closed");
    const proxy = await startProxy({ baseUrl: "http://upstream.example.test", port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Prove this theorem step by step and derive the result formally." }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get(routerHeader("model"))).toBe("pro");
    expect(res.headers.get(routerHeader("tier"))).toBe("REASONING");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:reasoning:pro:reasoning");
    expect(res.headers.get(routerHeader("fallback"))).toBe("false");
    expect(await res.json()).toEqual({
      error: {
        message: "Upstream request failed",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  });

  it("returns an OpenAI-compatible 500 when a reused session points to a missing physical model", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    vi.spyOn(SessionStore.prototype, "getSession").mockReturnValue({
      sessionId: "missing-physical-model-session",
      physicalModelId: "missing-physical-model",
      routedPublicModel: "pro",
      pinnedTier: "COMPLEX",
      createdAt: 0,
      updatedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      inputTokens: 0,
      outputTokens: 0,
      costEstimate: 0,
    });
    const proxy = await startProxy({
      config: withProxyOverrides(createAliasConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "missing-physical-model-session",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: {
        message: "Physical model not found in registry: missing-physical-model",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
  });

  it("returns 400 on invalid JSON body", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Invalid JSON body",
        type: "invalid_request_error",
        code: null,
      },
    });
  });

  it("rejects chat request bodies larger than the configured runtime limit", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      runtimeLimits: { maxBodyBytes: 32 },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "x".repeat(80) }],
      }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Payload Too Large",
        type: "invalid_request_error",
      },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("returns 408 when reading the chat request body times out", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      runtimeLimits: { bodyReadTimeoutMs: 30 },
    });
    handles.push(proxy);
    const keepAliveAgent = new http.Agent({ keepAlive: true });

    const result = await new Promise<{
      statusCode?: number;
      body: string;
      connectionHeader?: string;
      socketClosed: boolean;
    }>(
      (resolve, reject) => {
        let settled = false;
        let responseEnded = false;
        let sawResponse = false;
        let socketClosed = false;
        let statusCode: number | undefined;
        let connectionHeader: string | undefined;
        let responseBody = "";

        const cleanup = (): void => {
          clearTimeout(safetyTimeout);
          keepAliveAgent.destroy();
        };

        const rejectOnce = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const maybeResolve = (): void => {
          if (!responseEnded || !socketClosed) return;
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            statusCode,
            body: responseBody,
            connectionHeader,
            socketClosed,
          });
        };

        const safetyTimeout = setTimeout(() => {
          rejectOnce(
            new Error("Timed out waiting for proxy body-read timeout response"),
          );
        }, 1_000);

        const clientReq = http.request(
          {
            hostname: "127.0.0.1",
            port: proxy.port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "content-type": "application/json" },
            agent: keepAliveAgent,
          },
          (clientRes) => {
            sawResponse = true;
            statusCode = clientRes.statusCode;
            connectionHeader =
              typeof clientRes.headers.connection === "string"
                ? clientRes.headers.connection
                : undefined;

            clientRes.setEncoding("utf8");
            clientRes.on("data", (chunk) => {
              responseBody += chunk;
            });
            clientRes.on("end", () => {
              responseEnded = true;
              maybeResolve();
            });
            clientRes.on("error", rejectOnce);
          },
        );

        clientReq.on("socket", (socket) => {
          socket.on("close", () => {
            socketClosed = true;
            maybeResolve();
          });
        });

        clientReq.on("error", (error) => {
          if (sawResponse) return;
          rejectOnce(error);
        });
        clientReq.write('{"model":"auto","messages":[');
      },
    );

    expect(result.statusCode).toBe(408);
    expect(result.connectionHeader).toBe("close");
    expect(result.socketClosed).toBe(true);
    expect(JSON.parse(result.body)).toMatchObject({
      error: { message: "Request body read timeout" },
    });
    expect(upstream.requests).toHaveLength(0);
  });

  it("aborts the upstream chat request when the client disconnects", async () => {
    let resolveUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const upstream = await startUpstream((_upstreamReq, upstreamRes) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) return;
        settled = true;
        upstreamRes.off("close", onClose);
        resolveUpstreamClosed();
      };

      upstreamRes.on("close", onClose);
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port: proxy.port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    clientReq.on("error", () => {});
    clientReq.end(
      JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    await vi.waitFor(() => {
      expect(upstream.requests).toHaveLength(1);
    });

    clientReq.destroy();

    await expect(
      Promise.race([
        upstreamClosed,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                "Timed out waiting for upstream close after client disconnect",
              ),
            );
          }, 1_000);
        }),
      ]),
    ).resolves.toBeUndefined();
  });

  it("returns 504 when the upstream chat request times out", async () => {
    const upstream = await startUpstream(() => {
      // Intentionally keep the response open until proxy aborts.
    });
    handles.push(upstream);
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      runtimeLimits: { upstreamRequestTimeoutMs: 30 },
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Upstream request timed out",
        type: "invalid_request_error",
      },
    });
  });

  it("passes through streaming responses", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n");
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n");
      res.end("data: [DONE]\n\n");
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(await res.text()).toContain("data: [DONE]");
  });

  it("filters upstream router headers before injecting its own public headers", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        [routerHeader("model")]: "spoofed-model",
        [routerHeader("actual-model")]: "spoofed-actual-model",
        [routerHeader("routed")]: "spoofed-routed",
        [routerHeader("fallback")]: "spoofed-fallback",
        [routerHeader("upstream")]: "spoofed-upstream",
        [routerHeader("tier")]: "spoofed-tier",
        [routerHeader("trace")]: "spoofed-trace",
      });
      res.end(JSON.stringify({ id: "cmpl_1", choices: [{ message: { content: "ok" } }] }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "Return a strict JSON object matching the schema." },
          {
            role: "user",
            content:
              "Compare these two API response formats and summarize the compatibility risks for a migration plan.",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(routerHeader("model"))).toBe("flash");
    expect(res.headers.get(routerHeader("actual-model"))).toBe("deepseek-v4-flash");
    expect(res.headers.get(routerHeader("routed"))).toBe("true");
    expect(res.headers.get(routerHeader("fallback"))).toBe("false");
    expect(res.headers.get(routerHeader("upstream"))).toBe(upstream.baseUrl);
    expect(res.headers.get(routerHeader("tier"))).toBe("MEDIUM");
    expect(res.headers.get(routerHeader("trace"))).toBe("auto:medium:flash:first-pass");
  });
});
