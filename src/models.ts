export const SUPPORTED_MODEL_IDS = ["auto", "deepseek-v4-flash", "deepseek-v4-pro"] as const;
export type SupportedModelId = (typeof SUPPORTED_MODEL_IDS)[number];
