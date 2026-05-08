import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_PORT,
  parseHeaderJson,
  resolveConfig,
} from "../src/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("config", () => {
  it("uses defaults", () => {
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_ROUTER_PORT;
    delete process.env.DEEPSEEK_ROUTER_HEADERS;

    expect(resolveConfig()).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: undefined,
      headers: {},
      port: DEFAULT_PORT,
      defaultModel: "auto",
      sessionPinning: true,
    });
  });

  it("uses env vars and normalizes baseUrl", () => {
    process.env.DEEPSEEK_API_KEY = "env-key";
    process.env.DEEPSEEK_BASE_URL = "https://gateway.example.com///";
    process.env.DEEPSEEK_ROUTER_PORT = "9000";
    process.env.DEEPSEEK_ROUTER_HEADERS = "{\"X-Test\":\"yes\"}";

    expect(resolveConfig()).toMatchObject({
      baseUrl: "https://gateway.example.com",
      apiKey: "env-key",
      headers: { "X-Test": "yes" },
      port: 9000,
    });
  });

  it("lets overrides win over env vars", () => {
    process.env.DEEPSEEK_BASE_URL = "https://env.example.com";
    process.env.DEEPSEEK_ROUTER_HEADERS = "{\"X-Env\":\"yes\"}";

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
    expect(() => parseHeaderJson("[1,2,3]")).toThrow("expected object");
    expect(() => parseHeaderJson("{\"X\":1}")).toThrow("must be a string");
    expect(() => parseHeaderJson("{bad json")).toThrow("Invalid DEEPSEEK_ROUTER_HEADERS");
  });

  it("ignores invalid port env var", () => {
    process.env.DEEPSEEK_ROUTER_PORT = "99999";
    expect(resolveConfig().port).toBe(DEFAULT_PORT);
  });
});
