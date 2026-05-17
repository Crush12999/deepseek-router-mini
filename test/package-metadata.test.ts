import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const legacyPackageName = ["deepseek", "router", "mini"].join("-");
const legacyEnv = (name: string) => ["DEEPSEEK", name].join("_");

describe("package metadata", () => {
  it("declares xiaoyi-router package metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("xiaoyi-router");
    expect(pkg.bin).toEqual({ "xiaoyi-router": "./dist/cli.js" });
    expect(pkg.description).toBe(
      "xiaoyi local routing proxy for DeepSeek V4 Flash and DeepSeek V4 Pro.",
    );
    expect(JSON.stringify(pkg)).not.toContain(legacyPackageName);
  });

  it("keeps the package entrypoint focused on the built dist surface", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.types).toBe("dist/index.d.ts");
    expect(pkg.exports).toEqual({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    });
  });

  it("declares xiaoyi OpenClaw plugin metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
    const pluginJson = JSON.stringify(plugin);

    expect(plugin).toMatchObject({
      id: "xiaoyi-router",
      name: "Xiaoyi Router",
      version: pkg.version,
    });
    expect(plugin).not.toHaveProperty("providers");
    expect(plugin.description).toBe("Xiaoyi local routing proxy for OpenClaw");
    expect(plugin.configSchema.description).toContain("Provide either config or configPath");
    expect(plugin.configSchema.properties.config).toMatchObject({
      type: "object",
    });
    expect(plugin.configSchema.properties.config.description).toContain("Inline RawConfig");
    expect(plugin.configSchema.properties.configPath).toMatchObject({
      type: "string",
    });
    expect(plugin.configSchema.properties.configPath.description).toContain("Path to a RawConfig JSON file");
    expect(plugin.configSchema.properties.port.description).toContain("override config.proxy.port");
    expect(plugin.configSchema.properties.upstreamUrl.description).toContain("override config.proxy.upstreamUrl");
    expect(plugin.configSchema.properties.trace.description).toContain("override config.proxy.trace");
    expect(pluginJson).not.toContain("XIAOYI_BASE_URL");
    expect(pluginJson).not.toContain("XIAOYI_ROUTER_PORT");
    expect(pluginJson).not.toContain("XIAOYI_ROUTER_HEADERS");
    expect(pluginJson).not.toContain(legacyEnv("BASE_URL"));
    expect(pluginJson).not.toContain(legacyEnv("ROUTER_PORT"));
    expect(pluginJson).not.toContain(legacyEnv("ROUTER_HEADERS"));
    expect(pluginJson).not.toContain("DEEPSEEK_");
  });
});
