export const MODEL_ROLES = {
  auto: "auto",
  light: "deepseek-v4-flash",
  strong: "deepseek-v4-pro",
  reasoning: "deepseek-v4-pro",
  agentic: "deepseek-v4-pro",
} as const;

export const SUPPORTED_MODEL_IDS = [
  MODEL_ROLES.auto,
  MODEL_ROLES.light,
  MODEL_ROLES.strong,
] as const;

export type SupportedModelId = (typeof SUPPORTED_MODEL_IDS)[number];
export type RealModelId = Exclude<SupportedModelId, "auto">;
export type ModelRole = keyof typeof MODEL_ROLES;

export type XiaoyiModel = {
  id: SupportedModelId;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  toolCalling: boolean;
  roles: ModelRole[];
};

type XiaoyiModelDefinition = Omit<XiaoyiModel, "roles">;

const MODEL_DEFINITIONS: Record<SupportedModelId, XiaoyiModelDefinition> = {
  auto: {
    id: "auto",
    name: "Xiaoyi Auto",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    inputPrice: 0.56,
    outputPrice: 1.68,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
};

function deriveRolesForModel(modelId: SupportedModelId): ModelRole[] {
  return (Object.entries(MODEL_ROLES) as [ModelRole, SupportedModelId][])
    .filter(([, defaultModelId]) => defaultModelId === modelId)
    .map(([role]) => role);
}

export const XIAOYI_MODELS: XiaoyiModel[] = SUPPORTED_MODEL_IDS.map((modelId) => ({
  ...MODEL_DEFINITIONS[modelId],
  roles: deriveRolesForModel(modelId),
}));

const SUPPORTED_SET = new Set<string>(SUPPORTED_MODEL_IDS);
const MODEL_MAP = new Map<SupportedModelId, XiaoyiModel>(XIAOYI_MODELS.map((model) => [model.id, model]));

export function getDefaultModelForRole(role: Exclude<ModelRole, "auto">): RealModelId;
export function getDefaultModelForRole(role: ModelRole): SupportedModelId;
export function getDefaultModelForRole(role: ModelRole): SupportedModelId {
  return MODEL_ROLES[role];
}

export function isValidModel(modelId: string): modelId is SupportedModelId {
  return SUPPORTED_SET.has(modelId);
}

export function getModel(modelId: SupportedModelId): XiaoyiModel;
export function getModel(modelId: string): XiaoyiModel | undefined;
export function getModel(modelId: string): XiaoyiModel | undefined {
  if (!isValidModel(modelId)) {
    return undefined;
  }

  return MODEL_MAP.get(modelId);
}

export function isRealModel(modelId: SupportedModelId): modelId is RealModelId {
  return modelId !== "auto";
}

export function supportsToolCalling(modelId: string): boolean {
  return getModel(modelId)?.toolCalling ?? false;
}

export function supportsVision(): boolean {
  return false;
}

export function getModelContextWindow(modelId: string): number | undefined {
  return getModel(modelId)?.contextWindow;
}

function unsupportedModelError(modelId: string): Error {
  return new Error(
    `Unsupported model "${modelId}". Supported models: ${SUPPORTED_MODEL_IDS.join(", ")}`,
  );
}

export function getModelPricing(modelId: SupportedModelId): { inputPrice: number; outputPrice: number };
export function getModelPricing(modelId: string): { inputPrice: number; outputPrice: number };
export function getModelPricing(modelId: string): { inputPrice: number; outputPrice: number } {
  if (!isValidModel(modelId)) {
    throw unsupportedModelError(modelId);
  }

  const model = getModel(modelId);
  return {
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
  };
}

export function validateModelId(
  model: unknown,
): { ok: true; model: SupportedModelId } | { ok: false; message: string } {
  if (typeof model !== "string" || !isValidModel(model)) {
    return {
      ok: false,
      message: unsupportedModelError(String(model)).message,
    };
  }

  return { ok: true, model };
}
