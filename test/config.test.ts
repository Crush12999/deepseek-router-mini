import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_PORT,
  normalizeBaseUrl,
  resolveConfig,
} from "../src/config.js";

describe("config", () => {
  it("uses defaults", () => {
    expect(resolveConfig()).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      apiKey: undefined,
      headers: {},
      port: DEFAULT_PORT,
      sessionPinning: true,
      traceMode: "off",
    });
  });

  it("normalizes baseUrl trailing slashes", () => {
    expect(normalizeBaseUrl("https://gateway.example.com///")).toBe(
      "https://gateway.example.com",
    );
    expect(normalizeBaseUrl("https://example.com/v1/")).toBe(
      "https://example.com/v1",
    );
  });

  it("applies all provided overrides", () => {
    const result = resolveConfig({
      baseUrl: "https://override.example.com/v1/",
      apiKey: "my-key",
      headers: { "X-Custom": "yes" },
      port: 7777,
      sessionPinning: false,
      traceMode: "summary",
    });
    expect(result).toEqual({
      baseUrl: "https://override.example.com/v1",
      apiKey: "my-key",
      headers: { "X-Custom": "yes" },
      port: 7777,
      sessionPinning: false,
      traceMode: "summary",
    });
  });

  it("preserves an injected trace logger", () => {
    const traceLogger = {
      debug: () => {},
      info: () => {},
    };

    expect(resolveConfig({ traceLogger }).traceLogger).toBe(traceLogger);
  });
});
