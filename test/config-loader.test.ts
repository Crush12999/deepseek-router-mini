import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config-loader.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RawConfig } from "../src/config-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("loadConfig", () => {
  it("should load config from file", () => {
    const config = loadConfig({ kind: "file", path: join(__dirname, "fixtures/minimal-config.json") });
    expect(config.proxy.port).toBe(8402);
    expect(config.models).toHaveLength(1);
  });

  it("should reject missing auto in publicModels", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
      models: [],
      publicModels: {},
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash" },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/must contain.*auto/i);
  });

  it("should reject invalid candidate reference", () => {
    expect(() => loadConfig({ kind: "file", path: join(__dirname, "fixtures/invalid-config.json") })).toThrow(/unknown.*candidate/i);
  });

  it("should reject duplicate model IDs", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
      models: [
        { id: "dup", upstreamModel: "dup", name: "Dup", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
        { id: "dup", upstreamModel: "dup2", name: "Dup2", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: { auto: { kind: "router" } },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash" },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/duplicate.*dup/i);
  });

  it("should reject tier referencing non-alias publicModel", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
      models: [
        { id: "test", upstreamModel: "test", name: "Test", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: {
        auto: { kind: "router" },
        flash: { kind: "alias", candidates: ["test"] },
      },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "auto" }, // auto is router, not alias
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/tier.*invalid publicModel/i);
  });

  it("should reject empty candidates in alias", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
      models: [
        { id: "test", upstreamModel: "test", name: "Test", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: {
        auto: { kind: "router" },
        flash: { kind: "alias", candidates: [] },
      },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash" },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/candidates.*empty/i);
  });

  it("should reject invalid port number", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 99999, upstreamUrl: "https://api.test.com" },
      models: [
        { id: "test", upstreamModel: "test", name: "Test", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: {
        auto: { kind: "router" },
        flash: { kind: "alias", candidates: ["test"] },
      },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash" },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/port.*1-65535/i);
  });

  it("should reject non-string header values", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com", headers: { "X-Test": 123 } as any },
      models: [
        { id: "test", upstreamModel: "test", name: "Test", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: {
        auto: { kind: "router" },
        flash: { kind: "alias", candidates: ["test"] },
      },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash" },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/header.*string/i);
  });

  it("should reject fallback referencing non-existent model", () => {
    const raw: RawConfig = {
      version: 1,
      proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
      models: [
        { id: "test", upstreamModel: "test", name: "Test", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
      ],
      publicModels: {
        auto: { kind: "router" },
        flash: { kind: "alias", candidates: ["test"] },
      },
      routing: {
        tiers: {
          SIMPLE: { publicModel: "flash", fallback: ["unknown"] },
          MEDIUM: { publicModel: "flash" },
          COMPLEX: { publicModel: "flash" },
          REASONING: { publicModel: "flash" },
        },
        tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
        confidenceThreshold: 0.7,
        structuredOutputMinTier: "MEDIUM",
        ambiguousDefaultTier: "MEDIUM",
      },
    };
    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/fallback.*unknown/i);
  });
});
