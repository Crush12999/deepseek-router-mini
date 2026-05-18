import type {
  PhysicalModel,
  PublicModelMetadata,
  RawConfig,
} from "./config-schema.js";
import { createModelRegistry } from "./model-registry.js";
import { resolvePublicModelCandidate } from "./public-model-resolver.js";

/**
 * OpenClaw 侧约定的 provider 标识。
 *
 * Router 本身并不注册 provider 实现，但会持续修复
 * `models.providers.xiaoyiprovider` 这段配置。
 */
export const LLM_ROUTER_PROVIDER_ID = "xiaoyiprovider";
export const LLM_ROUTER_PROVIDER_NAME = "LLM Router Provider";
export const LLM_ROUTER_PROVIDER_DESCRIPTION =
  "LLM Router local routing provider for OpenAI-compatible models";
export const LLM_ROUTER_PROVIDER_API = "openai-completions";

/**
 * 写入 OpenClaw `models.providers.*.models[]` 时使用的模型元数据结构。
 *
 * 这里描述的是“OpenClaw 看到的模型目录项”，不等同于实际上游请求里的
 * physical model。
 */
export type OpenClawModelDefinition = {
  id: string;
  name: string;
  api: typeof LLM_ROUTER_PROVIDER_API;
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

/**
 * 沿用当前项目的成本近似规则：cache read 价格按 input 的 25% 估算。
 */
function cacheReadCost(inputPrice: number): number {
  return Number((inputPrice * 0.25).toFixed(2));
}

/**
 * 优先使用显式 metadata 生成 provider 条目。
 *
 * 这让 `auto` 之类的 router model，或显式提供了展示元数据的 alias，能够在
 * OpenClaw 里呈现稳定的名字、上下文长度和成本信息，而不必回退到某个
 * physical model。
 */
function fromMetadata(
  id: string,
  metadata: PublicModelMetadata,
): OpenClawModelDefinition {
  return {
    id,
    name: metadata.name,
    api: LLM_ROUTER_PROVIDER_API,
    reasoning: metadata.reasoning,
    input: ["text"],
    cost: metadata.cost,
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
}

/**
 * 当 alias 没有自定义 metadata 时，退化为使用其最终 physical model 的信息。
 */
function fromPhysicalModel(
  id: string,
  physicalModel: PhysicalModel,
): OpenClawModelDefinition {
  return {
    id,
    name: physicalModel.name,
    api: LLM_ROUTER_PROVIDER_API,
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

/**
 * 根据运行时配置生成 OpenClaw provider 模型目录。
 *
 * 注意：这个函数会为所有 `publicModels` 生成完整元数据；最终是否全部暴露给
 * OpenClaw，由调用方（当前是 `plugin.ts`）决定。这样可以把“生成目录”和
 * “裁剪对外暴露范围”两个职责分开。
 */
export function generateOpenClawModels(
  publicModels: RawConfig["publicModels"],
  physicalModels: PhysicalModel[],
): OpenClawModelDefinition[] {
  const registry = createModelRegistry(physicalModels);

  return Object.entries(publicModels).map(([id, publicModel]) => {
    // router model（当前即 auto）只能依赖 metadata，自身不能解析到 physical model。
    if (publicModel.kind === "router") {
      return fromMetadata(id, publicModel.metadata);
    }

    // alias 如果显式声明了 metadata，则以配置为准，不再借用底层 physical model 名片。
    if (publicModel.metadata) {
      return fromMetadata(id, publicModel.metadata);
    }

    // 否则把 alias 先解析到一个 physical model，再从物理模型反推展示信息。
    const physicalModel = resolvePublicModelCandidate(
      id,
      publicModels,
      registry,
    );
    return fromPhysicalModel(id, physicalModel);
  });
}
