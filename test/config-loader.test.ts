import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config-loader.js";
import type { RawConfig } from "../src/config-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalConfig = JSON.parse(
  readFileSync(join(__dirname, "fixtures/minimal-config.json"), "utf-8"),
) as RawConfig;

function cloneConfig(): RawConfig {
  return structuredClone(minimalConfig);
}

function cloneRouterMetadata(): Record<string, unknown> {
  const auto = structuredClone(minimalConfig.publicModels.auto);
  if (auto.kind !== "router") {
    throw new Error("test fixture publicModels.auto must be a router");
  }
  return structuredClone(auto.metadata) as Record<string, unknown>;
}

function cloneAliasPublicModel(id: string): Record<string, unknown> {
  const alias = structuredClone(minimalConfig.publicModels[id]);
  if (!alias || alias.kind !== "alias") {
    throw new Error(`test fixture publicModels.${id} must be an alias`);
  }
  return alias as unknown as Record<string, unknown>;
}

function setPublicModel(raw: RawConfig, id: string, value: unknown): void {
  (raw.publicModels as Record<string, unknown>)[id] = value;
}

describe("loadConfig", () => {
  it("should load config from file", () => {
    const config = loadConfig({ kind: "file", path: join(__dirname, "fixtures/minimal-config.json") });
    expect(config.proxy.port).toBe(8402);
    expect(config.models).toHaveLength(2);
  });

  it("should reject missing auto in publicModels", () => {
    const raw = cloneConfig();
    delete raw.publicModels.auto;

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/must contain.*auto/i);
  });

  it("requires auto to be router with metadata", () => {
    const raw = cloneConfig();
    raw.publicModels.auto = { kind: "alias", candidates: ["deepseek-v4-flash"] };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/auto.*router/i);
  });

  it("rejects auto router without metadata", () => {
    const raw = cloneConfig();
    setPublicModel(raw, "auto", { kind: "router" });

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/publicModels\.auto\.metadata.*required/i);
  });

  it("rejects non-auto router public models", () => {
    const raw = cloneConfig();
    setPublicModel(raw, "manual-router", {
      kind: "router",
      metadata: cloneRouterMetadata(),
    });

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /publicModels\.manual-router.*only auto.*router/i,
    );
  });

  it("rejects auto router metadata with missing required fields", () => {
    const raw = cloneConfig();
    const metadata = cloneRouterMetadata();
    delete metadata.name;
    setPublicModel(raw, "auto", { kind: "router", metadata });

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /publicModels\.auto\.metadata\.name.*required/i,
    );
  });

  it("rejects auto router with invalid metadata field types", () => {
    const raw = cloneConfig();
    const metadata = cloneRouterMetadata();
    metadata.name = 123;
    setPublicModel(raw, "auto", { kind: "router", metadata });

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /publicModels\.auto\.metadata\.name.*string/i,
    );
  });

  it.each([
    {
      name: "reasoning",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        metadata.reasoning = "yes";
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.reasoning.*boolean/i,
    },
    {
      name: "contextWindow",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        metadata.contextWindow = "1000000";
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.contextWindow.*number/i,
    },
    {
      name: "maxTokens",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        metadata.maxTokens = "64000";
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.maxTokens.*number/i,
    },
    {
      name: "cost object",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        metadata.cost = "free";
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.cost.*object/i,
    },
    {
      name: "cost.input",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        const cost = structuredClone(metadata.cost as Record<string, unknown>);
        cost.input = "0.28";
        metadata.cost = cost;
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.cost\.input.*number/i,
    },
    {
      name: "cost.output",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        const cost = structuredClone(metadata.cost as Record<string, unknown>);
        cost.output = "0.42";
        metadata.cost = cost;
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.cost\.output.*number/i,
    },
    {
      name: "cost.cacheRead",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        const cost = structuredClone(metadata.cost as Record<string, unknown>);
        cost.cacheRead = "0.07";
        metadata.cost = cost;
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.cost\.cacheRead.*number/i,
    },
    {
      name: "cost.cacheWrite",
      update: (raw: RawConfig) => {
        const metadata = cloneRouterMetadata();
        const cost = structuredClone(metadata.cost as Record<string, unknown>);
        cost.cacheWrite = "0.28";
        metadata.cost = cost;
        setPublicModel(raw, "auto", { kind: "router", metadata });
      },
      error: /publicModels\.auto\.metadata\.cost\.cacheWrite.*number/i,
    },
  ])("rejects auto router with invalid metadata $name", ({ update, error }) => {
    const raw = cloneConfig();
    update(raw);

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(error);
  });

  it("should reject invalid candidate reference", () => {
    expect(() => loadConfig({ kind: "file", path: join(__dirname, "fixtures/invalid-config.json") })).toThrow(
      /unknown.*candidate/i,
    );
  });

  it("should reject duplicate model IDs", () => {
    const raw = cloneConfig();
    raw.models.push(structuredClone(raw.models[0]) as RawConfig["models"][number]);

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/duplicate.*deepseek-v4-flash/i);
  });

  it("rejects tier target that points at router model", () => {
    const raw = cloneConfig();
    raw.routing.tiers.SIMPLE.publicModel = "auto";

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/SIMPLE.*alias/i);
  });

  it("should reject empty candidates in alias", () => {
    const raw = cloneConfig();
    raw.publicModels.flash = { kind: "alias", candidates: [] };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/candidates.*empty/i);
  });

  it("rejects alias metadata with invalid field types", () => {
    const raw = cloneConfig();
    const flash = cloneAliasPublicModel("flash");
    const metadata = cloneRouterMetadata();
    metadata.name = "DeepSeek V4 Flash";
    metadata.reasoning = "yes";
    flash.metadata = metadata;
    setPublicModel(raw, "flash", flash);

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /publicModels\.flash\.metadata\.reasoning.*boolean/i,
    );
  });

  it("accepts configurable routing tier boundaries and confidence threshold", () => {
    const raw = cloneConfig();
    raw.routing.tierBoundaries = {
      simpleMedium: 0.15,
      mediumComplex: 0.45,
      complexReasoning: 0.75,
    };
    raw.routing.confidenceThreshold = 0.7;

    expect(loadConfig({ kind: "inline", config: raw })).toEqual(raw);
  });

  it.each([
    ["simpleMedium", Number.NaN],
    ["simpleMedium", "0.1"],
    ["simpleMedium", Number.POSITIVE_INFINITY],
    ["mediumComplex", Number.NaN],
    ["mediumComplex", "0.4"],
    ["mediumComplex", Number.POSITIVE_INFINITY],
    ["complexReasoning", Number.NaN],
    ["complexReasoning", "0.8"],
    ["complexReasoning", Number.POSITIVE_INFINITY],
  ] satisfies Array<[keyof NonNullable<RawConfig["routing"]["tierBoundaries"]>, number | string]>)(
    "rejects invalid routing.tierBoundaries.%s",
    (key, value) => {
      const raw = cloneConfig();
      raw.routing.tierBoundaries = {
        simpleMedium: 0.15,
        mediumComplex: 0.45,
        complexReasoning: 0.75,
      };
      raw.routing.tierBoundaries[key] = value as never;

      expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
        new RegExp(`routing\\.tierBoundaries\\.${key}.*finite number`, "i"),
      );
    },
  );

  it("rejects non-monotonic boundaries", () => {
    const raw = cloneConfig();
    raw.routing.tierBoundaries = {
      simpleMedium: 0.5,
      mediumComplex: 0.4,
      complexReasoning: 0.9,
    };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(
      /simpleMedium <= mediumComplex <= complexReasoning/i,
    );
  });

  it.each([
    [-0.01, /between 0 and 1/i],
    [1.01, /between 0 and 1/i],
    [Number.NaN, /finite number/i],
    ["0.7", /finite number/i],
  ])("rejects invalid confidenceThreshold %s", (value, error) => {
    const raw = cloneConfig();
    raw.routing.confidenceThreshold = value as never;

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(error);
  });

  it("should reject invalid port number", () => {
    const raw = cloneConfig();
    raw.proxy.port = 99999;

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/port.*1-65535/i);
  });

  it("should reject non-string header values", () => {
    const raw = cloneConfig();
    raw.proxy.headers = { "X-Test": 123 as never };

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/header.*string/i);
  });

  it("should reject fallback referencing non-existent model", () => {
    const raw = cloneConfig();
    raw.routing.tiers.SIMPLE.fallback = ["unknown"];

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/fallback.*unknown/i);
  });

  it("should reject fallback referencing router public model", () => {
    const raw = cloneConfig();
    raw.routing.tiers.SIMPLE.fallback = ["auto"];

    expect(() => loadConfig({ kind: "inline", config: raw })).toThrow(/fallback.*alias/i);
  });
});
