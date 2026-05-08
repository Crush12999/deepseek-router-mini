import type { RealModelId } from "../models.js";

export type TaskCategory = "simple" | "standard" | "code" | "complex";

export type RouteInput = {
  prompt: string;
  systemPrompt?: string;
  hasTools?: boolean;
  estimatedInputChars?: number;
};

export type RouteDecision = {
  model: RealModelId;
  category: TaskCategory;
  reason: TaskCategory | "tools" | "long-context";
};
