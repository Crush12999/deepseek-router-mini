import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { startProxy } from "../src/proxy.js";

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
      const raw = await readBody(req);
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });

      if (handler) {
        handler(req, res);
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cmpl_1", choices: [{ message: { content: "ok" } }] }));
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

async function request(port: number, path: string, init: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

const handles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (handles.length) {
    await handles.pop()?.close();
  }
});

describe("proxy", () => {
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
    expect(res.headers.get("x-deepseek-router-model")).toBe("deepseek-v4-flash");
    expect(res.headers.get("x-deepseek-router-routed")).toBe("false");
    expect(upstream.requests[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer secret");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("routes auto requests to pro for tools", async () => {
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
        messages: [{ role: "user", content: "use tool" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-deepseek-router-model")).toBe("deepseek-v4-pro");
    expect(res.headers.get("x-deepseek-router-routed")).toBe("true");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "deepseek-v4-pro" });
  });
});
