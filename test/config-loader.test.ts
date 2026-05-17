import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config-loader.js";
import type { RawConfig } from "../src/config-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalConfig = JSON.parse(
  readFileSync(join(__dirname, "fixtures/minimal-config.json"), "utf-8")
) as RawConfig;

describe("loadConfig", () => {
  it("should load config from file", () => {
    const config = loadConfig({ kind: "file", path: join(__dirname, "fixtures/minimal-config.json") });
    expect(config.proxy.port).toBe(8402);
    expect(config.models).toHaveLength(2);
  });

  it("should reject missing auto in publicModels", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    delete raw.publicModels.auto;

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/must contain.*auto/i);
  });

  it("requires auto to be router with metadata", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.publicModels.auto = { kind: "alias", candidates: ["deepseek-v4-flash"] };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/auto.*router/i);
  });

  it("rejects auto router without metadata", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.publicModels.auto = { kind: "router" } as RawConfig["publicModels"][string];

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/publicModels\.auto\.metadata.*required/i);
  });

  it("rejects auto router with invalid metadata field types", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.publicModels.auto = {
      kind: "router",
      metadata: {
        ...raw.publicModels.auto.metadata,
        name: 123,
      },
    } as RawConfig["publicModels"][string];

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /publicModels\.auto\.metadata\.name.*string/i
    );
  });

  it("should reject invalid candidate reference", () => {
    expect(() => loadConfig({ kind: "file", path: join(__dirname, "fixtures/invalid-config.json") })).toThrow(
      /unknown.*candidate/i
    );
  });

  it("should reject duplicate model IDs", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.models.push(structuredClone(raw.models[0]) as RawConfig["models"][number]);

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/duplicate.*deepseek-v4-flash/i);
  });

  it("rejects tier target that points at router model", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.routing.tiers.SIMPLE.publicModel = "auto";

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/SIMPLE.*alias/i);
  });

  it("should reject empty candidates in alias", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.publicModels.flash = { kind: "alias", candidates: [] };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/candidates.*empty/i);
  });

  it("rejects removed routing scoring fields", () => {
    const raw = structuredClone(minimalConfig) as RawConfig & {
      routing: RawConfig["routing"] & { confidenceThreshold?: number };
    };
    raw.routing.confidenceThreshold = 0.7;

    expect(() => loadConfig({ kind: "inline", config: raw as RawConfig })).toThrow(
      /confidenceThreshold.*DEFAULT_ROUTING_CONFIG\.scoring/i
    );
  });

  it("should reject invalid port number", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.proxy.port = 99999;

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/port.*1-65535/i);
  });

  it("should reject non-string header values", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.proxy.headers = { "X-Test": 123 as never };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/header.*string/i);
  });

  it("should reject fallback referencing non-existent model", () => {
    const raw = structuredClone(minimalConfig) as RawConfig;
    raw.routing.tiers.SIMPLE.fallback = ["unknown"];

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/fallback.*unknown/i);
  });
});
