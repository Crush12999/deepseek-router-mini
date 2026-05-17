import type { PublicModelConfig } from "./config-schema.js";
import type { PhysicalModel } from "./config-schema.js";
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
  return resolvePublicModelCandidate(publicModelId, publicModels, registry).id;
}

/**
 * 将公开模型 ID 解析为物理模型
 * @param publicModelId 公开模型 ID（如 "flash", "pro"）
 * @param publicModels 公开模型配置映射
 * @param registry 物理模型注册表
 * @returns 选中的物理模型
 * @throws {Error} 如果公开模型不存在、kind 为 "router" 或候选模型不可用
 */
export function resolvePublicModelCandidate(
  publicModelId: string,
  publicModels: Record<string, PublicModelConfig>,
  registry: ModelRegistry,
): PhysicalModel {
  const pub = publicModels[publicModelId];
  if (!pub) {
    throw new Error(`Unknown public model: ${publicModelId}`);
  }
  if (pub.kind === "router") {
    throw new Error("Cannot resolve router model directly");
  }

  const candidateId = selectCandidateId(pub.candidates, registry, pub.selection ?? "cheapest");
  const candidate = registry.get(candidateId);
  if (!candidate) {
    throw new Error(`Candidate model not found in registry: ${candidateId}`);
  }
  return candidate;
}

function selectCandidateId(
  candidates: string[],
  registry: ModelRegistry,
  selection: "cheapest" | "first",
): string {
  if (candidates.length === 0) {
    throw new Error("No candidates available for public model");
  }
  if (selection === "first") {
    const first = candidates[0]!;
    if (!registry.has(first)) {
      throw new Error(`Candidate model not found in registry: ${first}`);
    }
    return first;
  }

  let selectedId: string | undefined;
  let selectedCost = Number.POSITIVE_INFINITY;

  for (const candidateId of candidates) {
    const model = registry.get(candidateId);
    if (!model) {
      throw new Error(`Candidate model not found in registry: ${candidateId}`);
    }

    const cost = model.inputPrice + model.outputPrice;
    if (cost < selectedCost) {
      selectedId = candidateId;
      selectedCost = cost;
    }
  }

  if (!selectedId) {
    throw new Error("No candidates available for public model");
  }

  return selectedId;
}
