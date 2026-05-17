import type { PhysicalModel, PublicModelMetadata, RawConfig } from "./config-schema.js";
import { createModelRegistry } from "./model-registry.js";
import { resolvePublicModelCandidate } from "./public-model-resolver.js";

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

function cacheReadCost(inputPrice: number): number {
  return Number((inputPrice * 0.25).toFixed(2));
}

function fromMetadata(id: string, metadata: PublicModelMetadata): OpenClawModelDefinition {
  return {
    id,
    name: metadata.name,
    api: XIAOYI_PROVIDER_API,
    reasoning: metadata.reasoning,
    input: ["text"],
    cost: metadata.cost,
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
}

function fromPhysicalModel(id: string, physicalModel: PhysicalModel): OpenClawModelDefinition {
  return {
    id,
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
}

export function generateOpenClawModels(
  publicModels: RawConfig["publicModels"],
  physicalModels: PhysicalModel[],
): OpenClawModelDefinition[] {
  const registry = createModelRegistry(physicalModels);

  return Object.entries(publicModels).map(([id, publicModel]) => {
    if (publicModel.kind === "router") {
      return fromMetadata(id, publicModel.metadata);
    }

    if (publicModel.metadata) {
      return fromMetadata(id, publicModel.metadata);
    }

    const physicalModel = resolvePublicModelCandidate(id, publicModels, registry);
    return fromPhysicalModel(id, physicalModel);
  });
}
