import type { PublicModelConfig } from "./config-schema.js";
import type { ModelRegistry } from "./model-registry.js";

/**
 * 将公开模型 ID 解析为物理模型 ID
 * @param publicModelId 公开模型 ID（如 "flash", "pro"）
 * @param publicModels 公开模型配置映射
 * @param registry 物理模型注册表
 * @returns 物理模型 ID
 * @throws {Error} 如果公开模型不存在或 kind 为 "router"
 */
export function resolvePublicModel(
  publicModelId: string,
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
): string {
  const pub = publicModels[publicModelId];
  if (!pub) {
    throw new Error(`Unknown public model: ${publicModelId}`);
  }
  if (pub.kind === "router") {
    throw new Error("Cannot resolve router model directly");
  }

  const selection = pub.selection ?? "cheapest";
  const sorted = sortCandidates(pub.candidates, registry, selection);
  if (sorted.length === 0) {
    throw new Error(`No candidates available for public model: ${publicModelId}`);
  }
  return sorted[0]!;
}

/**
 * 根据 selection 规则对候选模型排序
 * @param candidates 候选物理模型 ID 列表
 * @param registry 物理模型注册表
 * @param selection 选择规则："cheapest" 按价格升序，"first" 保持原顺序
 * @returns 排序后的候选列表
 */
function sortCandidates(
  candidates: string[],
  registry: ModelRegistry,
  selection: "cheapest" | "first",
): string[] {
  if (selection === "first") return candidates;

  return [...candidates].sort((a, b) => {
    const modelA = registry.get(a);
    const modelB = registry.get(b);
    if (!modelA) {
      throw new Error(`Candidate model not found in registry: ${a}`);
    }
    if (!modelB) {
      throw new Error(`Candidate model not found in registry: ${b}`);
    }
    const costA = modelA.inputPrice + modelA.outputPrice;
    const costB = modelB.inputPrice + modelB.outputPrice;
    return costA - costB;
  });
}
