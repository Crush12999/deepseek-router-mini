import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
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
const minimalConfig = JSON.parse(
  fs.readFileSync(path.join(root, "test/fixtures/minimal-config.json"), "utf8"),
);
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
if (mod.XIAOYI_OPENCLAW_MODELS !== undefined) throw new Error("legacy XIAOYI_OPENCLAW_MODELS export should be removed");
if (mod.XIAOYI_MODELS !== undefined) throw new Error("legacy XIAOYI_MODELS export should be removed");
if (mod.MODEL_ROLES !== undefined) throw new Error("legacy MODEL_ROLES export should be removed");
if (mod.getDefaultModelForRole !== undefined) throw new Error("legacy getDefaultModelForRole export should be removed");
if (mod.getModel !== undefined) throw new Error("legacy getModel export should be removed");
if (mod.isRealModel !== undefined) throw new Error("legacy isRealModel export should be removed");
if (mod.supportsToolCalling !== undefined) throw new Error("legacy supportsToolCalling export should be removed");
if (mod.supportsVision !== undefined) throw new Error("legacy supportsVision export should be removed");
if (mod.getModelContextWindow !== undefined) throw new Error("legacy getModelContextWindow export should be removed");
if (mod.getModelPricing !== undefined) throw new Error("legacy getModelPricing export should be removed");
if (typeof mod.loadConfig !== "function") throw new Error("missing loadConfig export");
if (typeof mod.createModelRegistry !== "function") throw new Error("missing createModelRegistry export");
if (typeof mod.resolvePublicModel !== "function") throw new Error("missing resolvePublicModel export");
if (typeof mod.generateOpenClawModels !== "function") throw new Error("missing generateOpenClawModels export");
if (typeof mod.injectLlmRouterModelsConfig !== "function") throw new Error("missing injectLlmRouterModelsConfig export");
if (mod.defaultPluginConfigPath !== undefined) throw new Error("defaultPluginConfigPath should not be public entrypoint API");
if (typeof mod.route !== "function") throw new Error("missing route export");
if (mod.DEFAULT_ROUTING_CONFIG?.overrides?.ambiguousDefaultTier !== "MEDIUM") {
  throw new Error("missing DEFAULT_ROUTING_CONFIG export");
}
if (mod.DEFAULT_RAW_CONFIG?.proxy?.port !== 8402) {
  throw new Error("missing DEFAULT_RAW_CONFIG export");
}
if (typeof mod.createDefaultRawConfig !== "function") {
  throw new Error("missing createDefaultRawConfig export");
}
const defaultConfigClone = mod.createDefaultRawConfig();
if (defaultConfigClone === mod.DEFAULT_RAW_CONFIG) {
  throw new Error("createDefaultRawConfig must return a clone");
}
defaultConfigClone.proxy.port = 9999;
if (mod.DEFAULT_RAW_CONFIG.proxy.port !== 8402) {
  throw new Error("DEFAULT_RAW_CONFIG should remain immutable");
}
if (typeof mod.getFallbackChain !== "function") throw new Error("missing getFallbackChain export");
if (typeof mod.filterByExcludeList !== "function") {
  throw new Error("missing filterByExcludeList export");
}
if (typeof mod.calculateModelCost !== "function") {
  throw new Error("missing calculateModelCost export");
}
if (mod.createXiaoyiProvider !== undefined) throw new Error("legacy createXiaoyiProvider export should be removed");
if (mod.LLM_ROUTER_PROVIDER_ID !== "xiaoyiprovider") {
  throw new Error("missing LLM_ROUTER_PROVIDER_ID export");
}
if (mod.LLM_ROUTER_PROVIDER_NAME !== "LLM Router Provider") {
  throw new Error("missing LLM_ROUTER_PROVIDER_NAME export");
}
if (mod.LLM_ROUTER_PROVIDER_API !== "openai-completions") {
  throw new Error("missing LLM_ROUTER_PROVIDER_API export");
}
if (mod.LLM_ROUTER_PROVIDER_DESCRIPTION !== "LLM Router local routing provider for OpenAI-compatible models") {
  throw new Error("missing LLM_ROUTER_PROVIDER_DESCRIPTION export");
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
  pluginConfig: { config: ${JSON.stringify(minimalConfig)} },
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
  pluginConfig: { config: ${JSON.stringify(minimalConfig)} },
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
  exportedFunctions: [
    typeof mod.loadConfig,
    typeof mod.createModelRegistry,
    typeof mod.resolvePublicModel,
    typeof mod.generateOpenClawModels,
  ]
}));
`;

describe("built package entrypoint", () => {
  it("exports the OpenClaw plugin object and key named exports from dist", async () => {
    await execFileAsync("npm", ["run", "build"]);

    const { stdout } = await execFileAsync("node", [
      "--input-type=module",
      "--eval",
      smokeScript,
    ]);
    const result = JSON.parse(stdout) as {
      id: string;
      version: string;
      exportedFunctions: string[];
    };

    expect(result).toMatchObject({
      id: pluginMetadata.id,
      version: expect.any(String),
      exportedFunctions: ["function", "function", "function", "function"],
    });
  }, 30_000);
});
