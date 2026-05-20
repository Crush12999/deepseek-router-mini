import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const legacyPackageName = ["deepseek", "router", "mini"].join("-");
const legacyEnv = (name: string) => ["DEEPSEEK", name].join("_");
const publicSurfaceFiles = [
  "package.json",
  "openclaw.plugin.json",
  "README.md",
  "docs/usage.md",
  "docs/development.md",
  "docs/design.md",
  "docs/migration-guide.md",
] as const;
const forbiddenLegacyPublicNames = [
  "xiaoyi-router",
  "Xiaoyi Router",
  "x-xiaoyi-router",
] as const;

describe("package metadata", () => {
  it("declares llm-router package metadata", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    expect(pkg.name).toBe("@yzj01/llm-router");
    expect(pkg.bin).toEqual({ "llm-router": "dist/cli.js" });
    expect(pkg.description).toBe(
      "LLM Router local routing proxy for OpenAI-compatible Chat Completions APIs.",
    );
    expect(JSON.stringify(pkg)).not.toContain(legacyPackageName);
  });

  it("keeps the package entrypoint focused on the built dist surface", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );

    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.types).toBe("dist/index.d.ts");
    expect(pkg.exports).toEqual({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    });
  });

  it("declares llm-router OpenClaw plugin metadata", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const plugin = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"),
    );
    const pluginJson = JSON.stringify(plugin);

    expect(plugin).toMatchObject({
      id: "llm-router",
      name: "LLM Router",
      version: pkg.version,
    });
    expect(plugin).not.toHaveProperty("providers");
    expect(plugin.description).toBe(
      "LLM Router local routing proxy for OpenClaw",
    );
    expect(plugin.configSchema.description).toContain("llm-router");
    expect(plugin.configSchema.properties.config).toMatchObject({
      type: "object",
    });
    expect(plugin.configSchema.properties.config.description).toContain(
      "llm-router",
    );
    expect(plugin.configSchema.properties.configPath).toMatchObject({
      type: "string",
    });
    expect(plugin.configSchema.properties.configPath.description).toContain(
      "llm-router",
    );
    expect(plugin.configSchema.properties.port.description).toContain(
      "override config.proxy.port",
    );
    expect(plugin.configSchema.properties.port).not.toHaveProperty("default");
    expect(plugin.configSchema.properties.upstreamUrl.description).toContain(
      "override config.proxy.upstreamUrl",
    );
    expect(plugin.configSchema.properties.upstreamUrl).not.toHaveProperty(
      "default",
    );
    expect(plugin.configSchema.properties.trace.description).toContain(
      "override config.proxy.trace",
    );
    expect(pluginJson).not.toContain("XIAOYI_BASE_URL");
    expect(pluginJson).not.toContain("XIAOYI_ROUTER_PORT");
    expect(pluginJson).not.toContain("XIAOYI_ROUTER_HEADERS");
    expect(pluginJson).not.toContain(legacyEnv("BASE_URL"));
    expect(pluginJson).not.toContain(legacyEnv("ROUTER_PORT"));
    expect(pluginJson).not.toContain(legacyEnv("ROUTER_HEADERS"));
    expect(pluginJson).not.toContain("DEEPSEEK_");
  });

  it("documents optional xiaoyiEnv headerMap config", () => {
    const plugin = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"),
    );

    expect(plugin.configSchema.properties.xiaoyiEnv).toMatchObject({
      type: "object",
      properties: {
        path: { type: "string" },
        headerMap: { type: "object" },
      },
    });
  });

  it("keeps package and docs free of legacy public names", () => {
    for (const relativePath of publicSurfaceFiles) {
      const content = fs.readFileSync(path.join(root, relativePath), "utf8");

      for (const legacyName of forbiddenLegacyPublicNames) {
        expect(
          content,
          `${relativePath} should not contain ${legacyName}`,
        ).not.toContain(legacyName);
      }
    }
  });
});
