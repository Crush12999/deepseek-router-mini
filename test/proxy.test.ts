import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startProxy } from "../src/proxy.js";
import { SessionStore } from "../src/session.js";

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
    expect((await request(proxy.port, "/v1/models")).status).toBe(404);
  });

  it("rejects unsupported models", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.5", messages: [] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Supported models") });
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
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-upstream")).toBe(upstream.baseUrl);
    expect(upstream.requests[0]?.url).toBe("/chat/completions");
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer secret");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("does not send authorization when apiKey and authorization headers are absent", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(upstream.requests[0]?.url).toBe("/v4/chat/completions");
  });

  it("routes auto code requests with tools to pro", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        tools: [{ type: "function", function: { name: "search" } }],
        messages: [{ role: "user", content: "Write a TypeScript function and use the tool" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-pro");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("true");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-pro" });
  });

  it("routes structured output system prompts to pro", async () => {
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
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-pro");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-pro" });
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
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
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
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
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
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
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
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
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
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
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
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
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
          { role: "system", content: "Return a strict JSON object matching the schema." },
          { role: "user", content: "Translate hello" },
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

  it("falls back from flash to pro on retryable upstream failure", async () => {
    let count = 0;
    const upstream = await startUpstream((_req, res) => {
      count += 1;
      if (count === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pro ok" } }] }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-pro");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("true");
    expect(requestedModels(upstream.requests)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("pins the actual fallback model for later auto requests", async () => {
    let count = 0;
    const upstream = await startUpstream((_req, res) => {
      count += 1;
      if (count === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "pro ok" } }] }));
    });
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "fallback-session" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);

    await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "fallback-session" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "Translate hello" }],
      }),
    });

    expect(requestedModels(upstream.requests)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-pro",
    ]);
  });

  it("escalates the proxy path after three identical auto requests and only does it once", async () => {
    const upstream = await startUpstream();
    handles.push(upstream);
    const proxy = await startProxy({ baseUrl: upstream.baseUrl, port: 0 });
    handles.push(proxy);

    const headers = { "content-type": "application/json", "x-session-id": "three-strike-session" };
    const body = JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "Translate hello" }],
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
      "deepseek-v4-pro",
      "deepseek-v4-pro",
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
        messages: [
          { role: "system", content: "Return a strict JSON object matching the schema." },
          { role: "user", content: "Translate hello" },
        ],
      }),
    });

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "debug" }],
      }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-pro");
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
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("uses a neutral fallback message for non-Error network failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue("socket closed");
    const proxy = await startProxy({ baseUrl: "http://upstream.example.test", port: 0 });
    handles.push(proxy);

    const res = await request(proxy.port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream request failed" });
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
    expect(await res.json()).toMatchObject({ error: "Invalid JSON body" });
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
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
    expect(await res.text()).toContain("data: [DONE]");
  });

  it("filters upstream router headers before injecting its own public headers", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-deepseek-router-model": "legacy-upstream-model",
        "x-deepseek-router-routed": "legacy-upstream-routed",
        "x-deepseek-router-fallback": "legacy-upstream-fallback",
        "x-deepseek-router-upstream": "legacy-upstream-upstream",
        "x-xiaoyi-router-model": "spoofed-model",
        "x-xiaoyi-router-routed": "spoofed-routed",
        "x-xiaoyi-router-fallback": "spoofed-fallback",
        "x-xiaoyi-router-upstream": "spoofed-upstream",
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
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-deepseek-router-model")).toBeNull();
    expect(res.headers.get("x-deepseek-router-routed")).toBeNull();
    expect(res.headers.get("x-deepseek-router-fallback")).toBeNull();
    expect(res.headers.get("x-deepseek-router-upstream")).toBeNull();
    expect(res.headers.get("x-xiaoyi-router-model")).toBe("deepseek-v4-flash");
    expect(res.headers.get("x-xiaoyi-router-routed")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-fallback")).toBe("false");
    expect(res.headers.get("x-xiaoyi-router-upstream")).toBe(upstream.baseUrl);
  });
});
