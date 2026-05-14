import { XIAOYI_MODELS } from "./models.js";
import type { SupportedModelId } from "./models.js";
import type { PublicModelConfig, PhysicalModel } from "./config-schema.js";

export const XIAOYI_PROVIDER_ID = "xiaoyiprovider";
export const XIAOYI_PROVIDER_NAME = "Xiaoyi Provider";
export const XIAOYI_PROVIDER_DESCRIPTION = "Xiaoyi local routing provider for DeepSeek-compatible models";
export const XIAOYI_PROVIDER_API = "openai-completions";

export type OpenClawModelDefinition = {
  id: string;
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

/**
 * Generate OpenClaw model definitions from configuration
 * @param publicModels Public model configuration mapping
 * @param physicalModels Physical model definitions for metadata lookup
 * @returns Array of OpenClaw model definitions
 */
export function generateOpenClawModels(
  publicModels: Record<string, PublicModelConfig>,
  physicalModels: PhysicalModel[]
): OpenClawModelDefinition[] {
  const modelMap = new Map(physicalModels.map((m) => [m.id, m]));

  return Object.keys(publicModels).map((publicId) => {
    // For router models (like "auto"), use default metadata
    const pubConfig = publicModels[publicId]!;
    if (pubConfig.kind === "router") {
      return {
        id: publicId,
        name: "Xiaoyi Auto",
        api: XIAOYI_PROVIDER_API,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      };
    }

    // For alias models, use the first candidate's metadata
    const firstCandidate = pubConfig.candidates[0];
    const physicalModel = modelMap.get(firstCandidate!);

    if (!physicalModel) {
      throw new Error(`Physical model not found for public model "${publicId}": ${firstCandidate}`);
    }

    return {
      id: publicId,
      name: physicalModel.name,
      api: XIAOYI_PROVIDER_API,
      reasoning: physicalModel.reasoning,
      input: ["text"],
      cost: {
        input: physicalModel.inputPrice,
        output: physicalModel.outputPrice,
        cacheRead: cacheReadCost(physicalModel.inputPrice),
        cacheWrite: physicalModel.inputPrice,
      },
      contextWindow: physicalModel.contextWindow,
      maxTokens: physicalModel.maxOutput,
    };
  });
}

// Backward compatibility: generate from XIAOYI_MODELS
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
