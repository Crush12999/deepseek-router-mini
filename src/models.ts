export const SUPPORTED_MODEL_IDS = ["auto", "deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type SupportedModelId = (typeof SUPPORTED_MODEL_IDS)[number];
export type RealModelId = Exclude<SupportedModelId, "auto">;

export type DeepSeekModel = {
  id: SupportedModelId;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning: boolean;
  toolCalling: boolean;
};

export const DEEPSEEK_MODELS: DeepSeekModel[] = [
  {
    id: "auto",
    name: "Auto",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    inputPrice: 0.56,
    outputPrice: 1.68,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
    reasoning: true,
    toolCalling: true,
  },
];

const SUPPORTED_SET = new Set<string>(SUPPORTED_MODEL_IDS);

export function getModel(modelId: string): DeepSeekModel | undefined {
  return DEEPSEEK_MODELS.find((model) => model.id === modelId);
}

export function isRealModel(modelId: SupportedModelId): modelId is RealModelId {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

export function validateModelId(
  model: unknown,
): { ok: true; model: SupportedModelId } | { ok: false; message: string } {
  if (typeof model !== "string" || !SUPPORTED_SET.has(model)) {
    return {
      ok: false,
      message: `Unsupported model "${String(model)}". Supported models: ${SUPPORTED_MODEL_IDS.join(", ")}`,
    };
  }

  return { ok: true, model: model as SupportedModelId };
}
