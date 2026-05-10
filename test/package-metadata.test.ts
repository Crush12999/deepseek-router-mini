import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("OpenClaw package metadata", () => {
  it("declares the OpenClaw extension entry and includes the plugin manifest in npm files", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      openclaw?: { extensions?: string[] };
      files?: string[];
    };

    expect(pkg.openclaw?.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "openclaw.plugin.json"]));
  });

  it("ships a minimal OpenClaw plugin manifest without auth profile configuration", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toEqual({
      id: "deepseek-router-mini",
      name: "DeepSeek Router Mini",
      description: "DeepSeek-only local routing proxy for OpenClaw",
      version: "0.1.0",
      main: "./dist/index.js",
      activation: {
        onStartup: true,
      },
      configSchema: {
        type: "object",
        properties: {
          port: {
            type: "number",
            default: 8402,
            description: "Local proxy port. Can also be set with DEEPSEEK_ROUTER_PORT.",
          },
          upstreamUrl: {
            type: "string",
            default: "https://api.deepseek.com",
            description: "DeepSeek-compatible upstream API base URL. Can also be set with DEEPSEEK_BASE_URL.",
          },
        },
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("authProfile");
    expect(JSON.stringify(manifest)).not.toContain("x402");
  });
});
