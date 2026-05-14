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
const legacyPrefix = ["DEEPSEEK"].join("");
const legacyExport = (name: string) => [legacyPrefix, name].join("_");

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
if (!Array.isArray(mod.XIAOYI_MODELS) || mod.XIAOYI_MODELS.length !== 3) {
  throw new Error("missing Xiaoyi model exports");
}
if (mod.MODEL_ROLES.light !== "deepseek-v4-flash") throw new Error("missing MODEL_ROLES export");
if (mod.getDefaultModelForRole("agentic") !== "deepseek-v4-pro") {
  throw new Error("missing getDefaultModelForRole export");
}
if (mod.getModel("deepseek-v4-flash")?.id !== "deepseek-v4-flash") {
  throw new Error("missing getModel export");
}
if (mod.getModel("not-a-model") !== undefined) throw new Error("getModel should reject unknown models");
if (!mod.isRealModel("deepseek-v4-pro")) throw new Error("missing isRealModel export");
if (mod.isRealModel("auto")) throw new Error("auto must not be treated as a real model");
if (!mod.supportsToolCalling("deepseek-v4-flash")) {
  throw new Error("missing supportsToolCalling export");
}
if (mod.supportsVision("deepseek-v4-flash")) throw new Error("Xiaoyi models should not support vision");
if (mod.getModelContextWindow("deepseek-v4-pro") !== 1000000) {
  throw new Error("missing getModelContextWindow export");
}
const pricing = mod.getModelPricing("deepseek-v4-pro");
if (pricing.inputPrice !== 0.56 || pricing.outputPrice !== 1.68) {
  throw new Error("missing getModelPricing export");
}
if (typeof mod.route !== "function") throw new Error("missing route export");
if (mod.DEFAULT_ROUTING_CONFIG?.overrides?.ambiguousDefaultTier !== "MEDIUM") {
  throw new Error("missing DEFAULT_ROUTING_CONFIG export");
}
if (typeof mod.getFallbackChain !== "function") throw new Error("missing getFallbackChain export");
if (typeof mod.getFallbackChainFiltered !== "function") {
  throw new Error("missing getFallbackChainFiltered export");
}
if (typeof mod.filterByToolCalling !== "function") {
  throw new Error("missing filterByToolCalling export");
}
if (typeof mod.filterByVision !== "function") throw new Error("missing filterByVision export");
if (typeof mod.filterByExcludeList !== "function") {
  throw new Error("missing filterByExcludeList export");
}
if (typeof mod.calculateModelCost !== "function") {
  throw new Error("missing calculateModelCost export");
}
if (typeof mod.createXiaoyiProvider !== "function") {
  throw new Error("missing createXiaoyiProvider export");
}
if (mod.XIAOYI_PROVIDER_ID !== "xiaoyiprovider") {
  throw new Error("missing XIAOYI_PROVIDER_ID export");
}
if (mod.XIAOYI_PROVIDER_NAME !== "Xiaoyi Provider") {
  throw new Error("missing XIAOYI_PROVIDER_NAME export");
}
if (mod.XIAOYI_PROVIDER_API !== "openai-completions") {
  throw new Error("missing XIAOYI_PROVIDER_API export");
}
for (const legacyKey of [
  ${JSON.stringify(legacyExport("MODELS"))},
  ${JSON.stringify(legacyExport("OPENCLAW_MODELS"))},
  ${JSON.stringify(legacyExport("PROVIDER_ID"))},
  "createDeepSeekProvider",
]) {
  if (legacyKey in mod) throw new Error("legacy export leaked from entrypoint: " + legacyKey);
}
const removedSessionPinExport = ["Session", "Pin", "Store"].join("");
if (removedSessionPinExport in mod) throw new Error("removed session pin store leaked from entrypoint");
for (const key of Object.keys(mod)) {
  if (key.includes("DEEPSEEK") || key.includes("DeepSeek")) {
    throw new Error(\`legacy export leaked from entrypoint: \${key}\`);
  }
}

const services = [];
const providers = [];
const config = {};
const result = mod.default.register({
  config,
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
if (providers.length !== 0) throw new Error("plugin register must not register provider");
if (services.length !== 0) throw new Error("discovery register should not register runtime service");
if (config?.models?.providers?.xiaoyiprovider?.baseUrl !== "http://127.0.0.1:8402/v1") {
  throw new Error("plugin register did not inject xiaoyiprovider baseUrl");
}
if (config?.models?.providers?.xiaoyiprovider?.api !== "openai-completions") {
  throw new Error("plugin register did not inject xiaoyiprovider api");
}

const secondConfig = {};
const secondResult = mod.default.register({
  config: secondConfig,
  registrationMode: "discovery",
  registerProvider(provider) {
    throw new Error("registerProvider should not be called in discovery mode");
  },
  registerService(service) {
    throw new Error("registerService should not be called in discovery mode");
  }
});
if (secondResult && typeof secondResult.then === "function") throw new Error("second plugin register returned a thenable");
if (secondResult !== undefined) throw new Error("second plugin register must return undefined");
if (secondConfig?.models?.providers?.xiaoyiprovider?.baseUrl !== "http://127.0.0.1:8402/v1") {
  throw new Error("second plugin register did not inject xiaoyiprovider baseUrl");
}
if (secondConfig?.models?.providers?.xiaoyiprovider?.api !== "openai-completions") {
  throw new Error("second plugin register did not inject xiaoyiprovider api");
}

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
