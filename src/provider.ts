import { XIAOYI_MODELS } from "./models.js";
import type { SupportedModelId } from "./models.js";

export const XIAOYI_PROVIDER_ID = "xiaoyiprovider";
export const XIAOYI_PROVIDER_NAME = "Xiaoyi Provider";
export const XIAOYI_PROVIDER_DESCRIPTION = "Xiaoyi local routing provider for DeepSeek-compatible models";
export const XIAOYI_PROVIDER_API = "openai-completions";

export type OpenClawModelDefinition = {
  id: SupportedModelId;
  name: string;
  api: typeof XIAOYI_PROVIDER_API;
  reasoning: boolean;
  input: ["text"];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

export type XiaoyiProvider = {
  id: typeof XIAOYI_PROVIDER_ID;
  name: typeof XIAOYI_PROVIDER_NAME;
  description: typeof XIAOYI_PROVIDER_DESCRIPTION;
  aliases: ["xiaoyi"];
  auth: [];
  models: {
    api: typeof XIAOYI_PROVIDER_API;
    baseUrl: string;
    models: OpenClawModelDefinition[];
  };
};

function modelName(id: SupportedModelId, name: string): string {
  return id === "auto" ? "Xiaoyi Auto" : name;
}

function cacheReadCost(inputPrice: number): number {
  return Number((inputPrice * 0.25).toFixed(2));
}

export const XIAOYI_OPENCLAW_MODELS: OpenClawModelDefinition[] = XIAOYI_MODELS.map((model) => ({
  id: model.id,
  name: modelName(model.id, model.name),
  api: XIAOYI_PROVIDER_API,
  reasoning: true,
  input: ["text"],
  cost: {
    input: model.inputPrice,
    output: model.outputPrice,
    cacheRead: cacheReadCost(model.inputPrice),
    cacheWrite: model.inputPrice,
  },
  contextWindow: model.contextWindow,
  maxTokens: model.maxOutput,
}));

export function createXiaoyiProvider(localProviderBaseUrl: string): XiaoyiProvider {
  return {
    id: XIAOYI_PROVIDER_ID,
    name: XIAOYI_PROVIDER_NAME,
    description: XIAOYI_PROVIDER_DESCRIPTION,
    aliases: ["xiaoyi"],
    auth: [],
    models: {
      api: XIAOYI_PROVIDER_API,
      baseUrl: localProviderBaseUrl,
      models: XIAOYI_OPENCLAW_MODELS,
    },
  };
}
