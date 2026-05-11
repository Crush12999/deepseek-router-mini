import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const legacyPackageName = ["deepseek", "router", "mini"].join("-");
const legacyEnv = (name: string) => ["DEEPSEEK", name].join("_");
const legacyOpenClawVersions = ["2026.3.24", "2026.4.11"] as const;

function parseOpenClawVersion(version: string): [number, number, number] {
  const cleaned = version.replace(/^v/, "");
  const match = cleaned.match(/^(\d{4})\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid OpenClaw version: ${version}`);

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function readMinimumHostVersion(range: string): string {
  const match = range.match(/^>=\s*(v?\d{4}\.\d+\.\d+)$/);
  if (!match) throw new Error(`Invalid OpenClaw host compatibility range: ${range}`);

  return match[1]!;
}

function compareOpenClawVersions(left: string, right: string): number {
  const leftParts = parseOpenClawVersion(left);
  const rightParts = parseOpenClawVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }

  return 0;
}

describe("package metadata", () => {
  it("declares xiaoyi-router package metadata", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.name).toBe("xiaoyi-router");
    expect(pkg.bin).toEqual({ "xiaoyi-router": "./dist/cli.js" });
    expect(pkg.description).toBe(
      "xiaoyi local routing proxy for DeepSeek V4 Flash and DeepSeek V4 Pro.",
    );
    expect(pkg.openclaw?.install?.minHostVersion).toEqual(expect.any(String));
    const minHostVersion = readMinimumHostVersion(pkg.openclaw.install.minHostVersion);
    for (const version of legacyOpenClawVersions) {
      expect(
        compareOpenClawVersions(version, minHostVersion),
        `OpenClaw ${version} must remain inside the package manifest compatibility range`,
      ).toBeGreaterThanOrEqual(0);
    }
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
