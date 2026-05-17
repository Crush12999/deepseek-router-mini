import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RawConfig } from "../src/config-schema.js";
import { startProxy as startProxyImpl } from "../src/proxy.js";
import type { ProxyOptions } from "../src/proxy.js";
import { SessionStore } from "../src/session.js";

const legacyRouterHeader = (name: string) => ["x", "deepseek", "router", name].join("-");

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

    return startProxyImpl({
      config,
      traceLogger: options.traceLogger,
      session: options.session,
    });
  }

  return startProxyImpl({
    config: withProxyOverrides(createAliasConfig(), {
      upstreamUrl: options.baseUrl,
      port: options.port,
      apiKey: options.apiKey,
      headers: options.headers,
      trace: options.traceMode,
    }),
    traceLogger: options.traceLogger,
    session: options.session,
  });
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
        message: expect.stringMatching(/unknown model/i),
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
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
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-actual-model")).toBe("deepseek-v4-flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("forwards explicit model requests with auth", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, apiKey: "secret" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-upstream")).toBe(upstream.baseUrl);
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
          model: "flash",
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
        model: "flash",
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
        model: "flash",
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
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
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
        model: "flash",
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("SIMPLE");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("auto:simple:flash:first-pass");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("true");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
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
      "[xiaoyi-router] auto:simple:flash:first-pass model=deepseek-v4-flash fallback=false",
    );
  });

  it("writes debug trace JSON with a prompt preview but without full prompt data", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "debug" });
    handles.push(proxy);
    const routePrompt = "一二三四五六七八九十abcdefghijklmnop中文测试尾巴";

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer should-not-be-logged",
      },
      body: JSON.stringify({
        model: "auto",
        messages: [
          { role: "system", content: "Never leak this complete system prompt." },
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
      promptPreview: "一二三四五六七八九十...mnop中文测试尾巴",
    });
    expect(logged).toHaveProperty("confidence");
    expect(logged).toHaveProperty("score");
    expect(logged).toHaveProperty("agenticScore");
    expect(logged).toHaveProperty("attempts", [{ model: "deepseek-v4-flash", status: "success" }]);
    expect(rawLog).not.toContain(routePrompt);
    expect(rawLog).not.toContain("Never leak this complete system prompt.");
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
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("pro");
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
    expect(second.headers.get("x-xiaoyi-router-trace")).toContain(":pro:");
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

  it("does not fabricate routing decision fields for explicit debug traces", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0, traceMode: "debug" });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const logged = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      trace: "explicit:medium:flash:user",
      requestedModel: "flash",
      routedModel: "flash",
      actualModel: "deepseek-v4-flash",
      sessionAction: "none",
    });
    expect(logged).not.toHaveProperty("method");
    expect(logged).not.toHaveProperty("confidence");
    expect(logged).not.toHaveProperty("score");
    expect(logged).not.toHaveProperty("agenticScore");
  });

  it("uses the configured SIMPLE tier for an explicit alias request", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      traceMode: "debug",
      config: withProxyOverrides(createConfigDrivenAliasTierConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lite",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("SIMPLE");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:simple:lite:user");
    const logged = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      trace: "explicit:simple:lite:user",
      requestedModel: "lite",
      routedModel: "lite",
      actualModel: "deepseek-v4-flash",
      tier: "SIMPLE",
      sessionAction: "none",
    });
  });

  it("keeps an explicit reasoning alias on the REASONING tier", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const logSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const proxy = await startProxy({
      baseUrl: upstream.baseUrl,
      port: 0,
      traceMode: "debug",
      config: withProxyOverrides(createConfigDrivenAliasTierConfig(), {
        upstreamUrl: upstream.baseUrl,
        port: 0,
      }),
    });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "think",
        messages: [{ role: "user", content: "reason carefully" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("REASONING");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:reasoning:think:user");
    const logged = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toMatchObject({
      trace: "explicit:reasoning:think:user",
      requestedModel: "think",
      routedModel: "think",
      actualModel: "deepseek-v4-pro",
      tier: "REASONING",
      sessionAction: "none",
    });
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

    const explicit = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "swift",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(explicit.status).toBe(200);
    expect(explicit.headers.get("x-xiaoyi-router-model")).toBe("swift");
    expect(explicit.headers.get("x-xiaoyi-router-actual-model")).toBe("deepseek-v4-flash");

    const routed = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(routed.status).toBe(200);
    expect(routed.headers.get("x-xiaoyi-router-model")).toBe("swift");
    expect(routed.headers.get("x-xiaoyi-router-actual-model")).toBe("deepseek-v4-flash");
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash", "deepseek-v4-flash"]);
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
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("routes by the final OpenClaw CLI turn inside a bootstrap-wrapped user message", async () => {
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
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
      body: JSON.stringify({ model: "flash", messages: [] }),
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
      body: JSON.stringify({ model: "flash", messages: [] }),
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
      body: JSON.stringify({ model: "flash", messages: [] }),
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

  it("does not pin an explicit pro success over a later simple auto request", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "explicit-pro-success" };

    const explicit = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "pro",
        messages: [{ role: "user", content: "debug this complex issue" }],
      }),
    });

    expect(explicit.status).toBe(200);

    const auto = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(auto.status).toBe(200);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });

  it("does not pin an explicit pro failure over a later simple auto request", async () => {
    let count = 0;
    const upstream = await startUpstream((_req, res) => {
      count += 1;
      if (count === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "flash ok" } }] }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "explicit-pro-failure" };

    const explicit = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "pro",
        messages: [{ role: "user", content: "debug this complex issue" }],
      }),
    });

    expect(explicit.status).toBe(503);

    const auto = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(auto.status).toBe(200);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("SIMPLE");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("auto:simple:flash:error");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(count).toBe(1);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash"]);
  });

  it("does not fall back from an explicit flash request when upstream fails", async () => {
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
      headers: { "content-type": "application/json", "x-session-id": "explicit-flash-failure" },
      body: JSON.stringify({
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("MEDIUM");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:medium:flash:user");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
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

  it("does not let an auto session pin override an explicit flash request", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "explicit-wins" };

    await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Prove this theorem step by step and derive the result formally." }],
      }),
    });

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });

  it("does not downgrade pro on retryable upstream failure", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pro",
        messages: [{ role: "user", content: "debug" }],
      }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("pro");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("REASONING");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:reasoning:pro:user");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(upstream.requests).toHaveLength(1);
  });

  it("returns 502 on network error to upstream", async () => {
    // Point proxy to a non-existent port — fetch will throw a network error.
    const proxy = await startProxy({ baseUrl: "http://127.0.0.1:1", port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("pro");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("REASONING");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:reasoning:pro:user");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
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
        model: "pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("pro");
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("REASONING");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:reasoning:pro:user");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
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
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(await res.text()).toContain("data: [DONE]");
  });

  it("filters upstream router headers before injecting its own public headers", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        [legacyRouterHeader("model")]: "legacy-upstream-model",
        [legacyRouterHeader("routed")]: "legacy-upstream-routed",
        [legacyRouterHeader("fallback")]: "legacy-upstream-fallback",
        [legacyRouterHeader("upstream")]: "legacy-upstream-upstream",
        "x-xiaoyi-router-model": "spoofed-model",
        "x-xiaoyi-router-routed": "spoofed-routed",
        "x-xiaoyi-router-fallback": "spoofed-fallback",
        "x-xiaoyi-router-upstream": "spoofed-upstream",
        "x-xiaoyi-router-tier": "spoofed-tier",
        "x-xiaoyi-router-trace": "spoofed-trace",
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
        model: "flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(legacyRouterHeader("model"))).toBeNull();
    expect(res.headers.get(legacyRouterHeader("routed"))).toBeNull();
    expect(res.headers.get(legacyRouterHeader("fallback"))).toBeNull();
    expect(res.headers.get(legacyRouterHeader("upstream"))).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("flash");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-upstream")).toBe(upstream.baseUrl);
    expect(res.headers.get("x-xiaoyi-router-tier")).toBe("MEDIUM");
    expect(res.headers.get("x-xiaoyi-router-trace")).toBe("explicit:medium:flash:user");
  });
});
