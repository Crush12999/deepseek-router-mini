import { MODEL_ROLES } from "../models.js";
import type { RoutingDecision, Tier, TierConfig } from "./types.js";

export type ModelPricing = {
  inputPrice: number;
  outputPrice: number;
};

const BASELINE_MODEL_ID = MODEL_ROLES.strong;
const BASELINE_INPUT_PRICE = 0.56;
const BASELINE_OUTPUT_PRICE = 1.68;

export function selectModel(
  tier: Tier,
  confidence: number,
  method: "rules" | "llm",
  reasoning: string,
  tierConfigs: Record<Tier, TierConfig>,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  agenticScore?: number,
  score?: number,
): RoutingDecision;
export function selectModel(
  tier: Tier,
  confidence: number,
  method: "rules" | "llm",
  reasoning: string,
  tierConfigs: Record<Tier, TierConfig>,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  agenticScore?: number,
  score?: number,
): RoutingDecision {
  const config = tierConfigs[tier];
  if (!config) {
    throw new Error(`Missing tier config for ${tier}`);
  }

  const model = config.primary;
  const costs = calculateModelCost(
    model,
    modelPricing,
    estimatedInputTokens,
    maxOutputTokens,
  );

  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    ...costs,
    ...(agenticScore !== undefined && { agenticScore }),
    ...(score !== undefined && { score }),
  };
}

export function getFallbackChain(tier: Tier, tierConfigs: Record<Tier, TierConfig>): string[] {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}

export function calculateModelCost(
  model: string,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): { costEstimate: number; baselineCost: number; savings: number } {
  const pricing = modelPricing.get(model);
  const inputCost = (estimatedInputTokens / 1_000_000) * (pricing?.inputPrice ?? 0);
  const outputCost = (maxOutputTokens / 1_000_000) * (pricing?.outputPrice ?? 0);
  const costEstimate = inputCost + outputCost;

  const baselinePricing = modelPricing.get(BASELINE_MODEL_ID);
  const baselineInput = (estimatedInputTokens / 1_000_000) * (baselinePricing?.inputPrice ?? BASELINE_INPUT_PRICE);
  const baselineOutput = (maxOutputTokens / 1_000_000) * (baselinePricing?.outputPrice ?? BASELINE_OUTPUT_PRICE);
  const baselineCost = baselineInput + baselineOutput;
  const savings =
    baselineCost > 0
      ? Math.max(0, (baselineCost - costEstimate) / baselineCost)
      : 0;

  return { costEstimate, baselineCost, savings };
}

export function filterByToolCalling(
  models: string[],
  hasTools: boolean,
  supportsToolCalling: (modelId: string) => boolean,
): string[] {
  if (!hasTools) return models;
  const filtered = models.filter(supportsToolCalling);
  return filtered.length > 0 ? filtered : models;
}

export function filterByVision(
  models: string[],
  hasVision: boolean,
  supportsVision: (modelId: string) => boolean,
): string[] {
  if (!hasVision) return models;
  const filtered = models.filter(supportsVision);
  return filtered.length > 0 ? filtered : models;
}

export function filterByExcludeList(models: string[], excludeList: Set<string>): string[] {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((model) => !excludeList.has(model));
  return filtered.length > 0 ? filtered : models;
}

export function getFallbackChainFiltered(
  tier: Tier,
  tierConfigs: Record<Tier, TierConfig>,
  estimatedTotalTokens: number,
  getContextWindow: (modelId: string) => number | undefined,
): string[] {
  const fullChain = getFallbackChain(tier, tierConfigs);
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    return contextWindow === undefined || contextWindow >= estimatedTotalTokens * 1.1;
  });

  return filtered.length > 0 ? filtered : fullChain;
}
