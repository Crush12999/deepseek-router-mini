import type { RoutingDecision, Tier, TierConfig } from "./types.js";

/**
 * 路由层只关心 alias 的成本画像，因此这里的 key 是 public alias，而不是
 * physical model ID。
 */
export type ModelPricing = {
  inputPrice: number;
  outputPrice: number;
};

const DEFAULT_BASELINE_INPUT_PRICE = 0.56;
const DEFAULT_BASELINE_OUTPUT_PRICE = 1.68;

/**
 * 把 tier 选择结果转换成统一的 RoutingDecision，并补齐成本估算字段。
 */
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

  // `primary` 在当前阶段表示“语义层 alias 选择结果”，不是 physical model。
  const model = config.primary;
  const baselineModel = tierConfigs["COMPLEX"].primary;
  const costs = calculateModelCost(
    model,
    modelPricing,
    estimatedInputTokens,
    maxOutputTokens,
    baselineModel,
  );

  return {
    publicModel: model,
    tier,
    confidence,
    method,
    reasoning,
    ...costs,
    ...(agenticScore !== undefined && { agenticScore }),
    ...(score !== undefined && { score }),
  };
}

/**
 * 返回某个 tier 的完整尝试链：先 primary，再按顺序追加 fallback。
 */
export function getFallbackChain(
  tier: Tier,
  tierConfigs: Record<Tier, TierConfig>,
): string[] {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}

/**
 * 按 1M token 单价估算当前 alias 的输入 / 输出成本，并和 baseline 进行对比。
 */
export function calculateModelCost(
  model: string,
  modelPricing: Map<string, ModelPricing>,
  estimatedInputTokens: number,
  maxOutputTokens: number,
  baselineModelId?: string,
): { costEstimate: number; baselineCost: number; savings: number } {
  const pricing = modelPricing.get(model);
  const inputCost =
    (estimatedInputTokens / 1_000_000) * (pricing?.inputPrice ?? 0);
  const outputCost =
    (maxOutputTokens / 1_000_000) * (pricing?.outputPrice ?? 0);
  const costEstimate = inputCost + outputCost;

  const baselinePricing = baselineModelId
    ? modelPricing.get(baselineModelId)
    : undefined;
  const baselineInput =
    (estimatedInputTokens / 1_000_000) *
    (baselinePricing?.inputPrice ?? DEFAULT_BASELINE_INPUT_PRICE);
  const baselineOutput =
    (maxOutputTokens / 1_000_000) *
    (baselinePricing?.outputPrice ?? DEFAULT_BASELINE_OUTPUT_PRICE);
  const baselineCost = baselineInput + baselineOutput;
  const savings =
    baselineCost > 0
      ? Math.max(0, (baselineCost - costEstimate) / baselineCost)
      : 0;

  return { costEstimate, baselineCost, savings };
}

/**
 * 从候选链里剔除不允许继续尝试的模型；如果剔除后为空，则保底返回原链，避免
 * 调用方拿到“无路可走”的空数组。
 */
export function filterByExcludeList(
  models: string[],
  excludeList: Set<string>,
): string[] {
  if (excludeList.size === 0) return models;
  const filtered = models.filter((model) => !excludeList.has(model));
  return filtered.length > 0 ? filtered : models;
}
