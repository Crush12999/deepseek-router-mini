import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string;
  description: string;
};
const pluginMetadata = JSON.parse(
  fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf8"),
) as {
  id: string;
  name: string;
  description: string;
};

const smokeScript = `
const mod = await import(${JSON.stringify(pkg.name)});

if (!mod.default) throw new Error("missing default export");
if (mod.default.id !== ${JSON.stringify(pluginMetadata.id)}) throw new Error("unexpected plugin id");
if (mod.default.name !== ${JSON.stringify(pluginMetadata.name)}) throw new Error("unexpected plugin name");
if (mod.default.description !== ${JSON.stringify(pluginMetadata.description)}) {
  throw new Error("unexpected plugin description");
}
if (mod.default.version !== mod.VERSION) throw new Error("plugin version does not match VERSION");
if (typeof mod.default.register !== "function") throw new Error("missing plugin register function");
if (typeof mod.startProxy !== "function") throw new Error("missing startProxy export");
if (!Array.isArray(mod.XIAOYI_OPENCLAW_MODELS) || mod.XIAOYI_OPENCLAW_MODELS.length !== 3) {
  throw new Error("missing Xiaoyi OpenClaw model exports");
}
for (const key of Object.keys(mod)) {
  if (key.includes("DEEPSEEK") || key.includes("DeepSeek")) {
    throw new Error(\`legacy export leaked from entrypoint: \${key}\`);
  }
}

const services = [];
const providers = [];
const result = mod.default.register({
  config: {},
  registrationMode: "discovery",
  registerProvider(provider) {
    providers.push(provider);
  },
  registerService(service) {
    services.push(service);
  }
});
if (result && typeof result.then === "function") throw new Error("plugin register returned a thenable");
if (result !== undefined) throw new Error("plugin register must return undefined");
if (providers.length !== 1) throw new Error("plugin register did not register provider");
if (services.length !== 0) throw new Error("discovery register should not register runtime service");

console.log(JSON.stringify({
  id: mod.default.id,
  version: mod.default.version,
  modelCount: mod.XIAOYI_OPENCLAW_MODELS.length
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
        id: pluginMetadata.id,
        version: expect.any(String),
        modelCount: 3,
      });
    },
    30_000,
  );
});
