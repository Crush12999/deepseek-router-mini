import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config-loader.js";
import {
  createDefaultRawConfig,
  DEFAULT_RAW_CONFIG,
} from "../src/default-config.js";

const minimalConfigFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/minimal-config.json", import.meta.url),
    "utf8",
  ),
);

describe("DEFAULT_RAW_CONFIG", () => {
  it("matches the minimal fixture exactly and stays a valid fallback config", () => {
    expect(DEFAULT_RAW_CONFIG).toEqual(minimalConfigFixture);

    const config = loadConfig({
      kind: "inline",
      config: createDefaultRawConfig(),
    });

    expect(config.proxy).toMatchObject({
      port: 8402,
      upstreamUrl: "https://api.deepseek.com",
      trace: "off",
    });
    expect(config.proxy).not.toHaveProperty("apiKey");
    expect(config.publicModels.auto?.kind).toBe("router");
    expect(config.publicModels.flash?.kind).toBe("alias");
    expect(config.publicModels.pro?.kind).toBe("alias");
    expect(Object.keys(config.routing.tiers).sort()).toEqual([
      "COMPLEX",
      "MEDIUM",
      "REASONING",
      "SIMPLE",
    ]);
  });

  it("prevents callers from mutating the shared default config", () => {
    expect(() => {
      DEFAULT_RAW_CONFIG.proxy.port = 9999;
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RAW_CONFIG.models.push(
        structuredClone(DEFAULT_RAW_CONFIG.models[0]),
      );
    }).toThrow(TypeError);

    expect(DEFAULT_RAW_CONFIG.proxy.port).toBe(8402);
    expect(DEFAULT_RAW_CONFIG.models).toHaveLength(2);
    expect(DEFAULT_RAW_CONFIG).toEqual(minimalConfigFixture);
  });
});

describe("createDefaultRawConfig", () => {
  it("returns a mutable clone without changing DEFAULT_RAW_CONFIG", () => {
    const clonedConfig = createDefaultRawConfig();

    expect(clonedConfig).toEqual(DEFAULT_RAW_CONFIG);
    expect(clonedConfig).not.toBe(DEFAULT_RAW_CONFIG);
    expect(clonedConfig.proxy).not.toBe(DEFAULT_RAW_CONFIG.proxy);

    clonedConfig.proxy.port = 9999;
    clonedConfig.models.push(structuredClone(clonedConfig.models[0]));

    expect(clonedConfig.proxy.port).toBe(9999);
    expect(clonedConfig.models).toHaveLength(3);
    expect(DEFAULT_RAW_CONFIG.proxy.port).toBe(8402);
    expect(DEFAULT_RAW_CONFIG.models).toHaveLength(2);
  });
});
