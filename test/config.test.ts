import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_PORT,
  parseHeaderJson,
  resolveConfig,
} from "../src/config.js";

const originalEnv = { ...process.env };
const legacyEnv = (name: string) => ["DEEPSEEK", name].join("_");

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("config", () => {
  it("uses defaults", () => {
    delete process.env.XIAOYI_API_KEY;
    delete process.env.XIAOYI_BASE_URL;
    delete process.env.XIAOYI_ROUTER_PORT;
    delete process.env.XIAOYI_ROUTER_HEADERS;
    delete process.env.XIAOYI_ROUTER_TRACE;

    expect(resolveConfig()).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: undefined,
      headers: {},
      port: DEFAULT_PORT,
      defaultModel: "auto",
      sessionPinning: true,
      traceMode: "off",
    });
  });

  it("ignores legacy upstream env vars", () => {
    delete process.env.XIAOYI_API_KEY;
    delete process.env.XIAOYI_BASE_URL;
    delete process.env.XIAOYI_ROUTER_PORT;
    delete process.env.XIAOYI_ROUTER_HEADERS;
    delete process.env.XIAOYI_ROUTER_TRACE;
    process.env[legacyEnv("API_KEY")] = "legacy-key";
    process.env[legacyEnv("BASE_URL")] = "https://legacy.example.com";
    process.env[legacyEnv("ROUTER_PORT")] = "9001";
    process.env[legacyEnv("ROUTER_HEADERS")] = "{\"X-Legacy\":\"yes\"}";

    expect(resolveConfig()).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: undefined,
      headers: {},
      port: DEFAULT_PORT,
      defaultModel: "auto",
      sessionPinning: true,
      traceMode: "off",
    });
  });

  it("uses env vars and normalizes baseUrl", () => {
    process.env.XIAOYI_API_KEY = "env-key";
    process.env.XIAOYI_BASE_URL = "https://gateway.example.com///";
    process.env.XIAOYI_ROUTER_PORT = "9000";
    process.env.XIAOYI_ROUTER_HEADERS = "{\"X-Test\":\"yes\"}";

    expect(resolveConfig()).toMatchObject({
      baseUrl: "https://gateway.example.com",
      apiKey: "env-key",
      headers: { "X-Test": "yes" },
      port: 9000,
    });
  });

  it("lets overrides win over env vars", () => {
    process.env.XIAOYI_BASE_URL = "https://env.example.com";
    process.env.XIAOYI_ROUTER_HEADERS = "{\"X-Env\":\"yes\"}";

    expect(
      resolveConfig({
        baseUrl: "https://override.example.com/v1/",
        headers: { "X-Override": "yes" },
        port: 7777,
      }),
    ).toMatchObject({
      baseUrl: "https://override.example.com/v1",
      headers: { "X-Env": "yes", "X-Override": "yes" },
      port: 7777,
    });
  });

  it("rejects invalid header JSON", () => {
    expect(() => parseHeaderJson("[1,2,3]")).toThrow("Invalid XIAOYI_ROUTER_HEADERS");
    expect(() => parseHeaderJson("{\"X\":1}")).toThrow("Invalid XIAOYI_ROUTER_HEADERS");
    expect(() => parseHeaderJson("{bad json")).toThrow("Invalid XIAOYI_ROUTER_HEADERS");
  });

  it("ignores invalid port env var", () => {
    process.env.XIAOYI_ROUTER_PORT = "99999";
    expect(resolveConfig().port).toBe(DEFAULT_PORT);
  });
});
