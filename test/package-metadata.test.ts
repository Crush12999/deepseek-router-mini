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

  it("declares xiaoyi OpenClaw plugin metadata", () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"));
    expect(plugin).toMatchObject({
      id: "xiaoyi-router",
      name: "Xiaoyi Router",
    });
    expect(plugin).not.toHaveProperty("providers");
    expect(plugin.description).toBe("Xiaoyi local routing proxy for OpenClaw");
    expect(plugin.configSchema.properties.upstreamUrl.description).toBe(
      "DeepSeek-compatible upstream API base URL. Can also be set with XIAOYI_BASE_URL.",
    );
    expect(plugin.configSchema.properties.port.description).toBe(
      "Local proxy port. Can also be set with XIAOYI_ROUTER_PORT.",
    );
    expect(JSON.stringify(plugin)).not.toContain(legacyEnv("BASE_URL"));
    expect(JSON.stringify(plugin)).not.toContain(legacyEnv("ROUTER_PORT"));
    expect(JSON.stringify(plugin)).not.toContain(legacyEnv("ROUTER_HEADERS"));
  });
});
