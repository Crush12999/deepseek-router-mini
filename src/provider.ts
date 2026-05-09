import { DEEPSEEK_MODELS } from "./models.js";
import type { SupportedModelId } from "./models.js";

export const DEEPSEEK_PROVIDER_ID = "deepseek";
export const DEEPSEEK_PROVIDER_API = "openai-completions";

export type OpenClawModelDefinition = {
  id: SupportedModelId;
  name: string;
  api: typeof DEEPSEEK_PROVIDER_API;
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

export type DeepSeekProvider = {
  id: typeof DEEPSEEK_PROVIDER_ID;
  name: "DeepSeek";
  aliases: ["ds"];
  auth: [];
  models: {
    api: typeof DEEPSEEK_PROVIDER_API;
    baseUrl: string;
    models: OpenClawModelDefinition[];
  };
};

function modelName(id: SupportedModelId, name: string): string {
  return id === "auto" ? "DeepSeek Auto" : name;
}

function cacheReadCost(inputPrice: number): number {
  return Number((inputPrice * 0.25).toFixed(2));
}

export const DEEPSEEK_OPENCLAW_MODELS: OpenClawModelDefinition[] = DEEPSEEK_MODELS.map((model) => ({
  id: model.id,
  name: modelName(model.id, model.name),
  api: DEEPSEEK_PROVIDER_API,
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

export function createDeepSeekProvider(localProviderBaseUrl: string): DeepSeekProvider {
  return {
    id: DEEPSEEK_PROVIDER_ID,
    name: "DeepSeek",
    aliases: ["ds"],
    auth: [],
    models: {
      api: DEEPSEEK_PROVIDER_API,
      baseUrl: localProviderBaseUrl,
      models: DEEPSEEK_OPENCLAW_MODELS,
    },
  };
}
