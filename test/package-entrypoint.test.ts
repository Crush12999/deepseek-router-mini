import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const smokeScript = `
const mod = await import("deepseek-router-mini");

if (!mod.default) throw new Error("missing default export");
if (mod.default.id !== "deepseek-router-mini") throw new Error("unexpected plugin id");
if (mod.default.name !== "DeepSeek Router Mini") throw new Error("unexpected plugin name");
if (mod.default.description !== "DeepSeek-only local routing proxy for OpenClaw") {
  throw new Error("unexpected plugin description");
}
if (mod.default.version !== mod.VERSION) throw new Error("plugin version does not match VERSION");
if (typeof mod.default.register !== "function") throw new Error("missing plugin register function");
if (typeof mod.startProxy !== "function") throw new Error("missing startProxy export");
if (!Array.isArray(mod.DEEPSEEK_OPENCLAW_MODELS) || mod.DEEPSEEK_OPENCLAW_MODELS.length !== 3) {
  throw new Error("missing DeepSeek OpenClaw model exports");
}

console.log(JSON.stringify({
  id: mod.default.id,
  version: mod.default.version,
  modelCount: mod.DEEPSEEK_OPENCLAW_MODELS.length
}));
`;

describe("built package entrypoint", () => {
  it(
    "exports the OpenClaw plugin object and key named exports from dist",
    async () => {
      await execFileAsync("npm", ["run", "build"]);

      const { stdout } = await execFileAsync("node", ["--input-type=module", "--eval", smokeScript]);
      const result = JSON.parse(stdout) as { id: string; version: string; modelCount: number };

      expect(result).toMatchObject({
        id: "deepseek-router-mini",
        version: expect.any(String),
        modelCount: 3,
      });
    },
    30_000,
  );
});
