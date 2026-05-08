import { LONG_CONTEXT_CHARS } from "./rules.js";
import { classifyPrompt } from "./classifier.js";
import type { RouteDecision, RouteInput } from "./types.js";

export function selectModel(input: RouteInput): RouteDecision {
  const estimatedChars =
    input.estimatedInputChars ?? input.prompt.length + (input.systemPrompt?.length ?? 0);
  const category = classifyPrompt(input.prompt, input.systemPrompt);

  if (input.hasTools) {
    return { model: "deepseek-v4-pro", category, reason: "tools" };
  }

  if (estimatedChars >= LONG_CONTEXT_CHARS) {
    return { model: "deepseek-v4-pro", category, reason: "long-context" };
  }

  if (category === "complex") {
    return { model: "deepseek-v4-pro", category, reason: "complex" };
  }

  return { model: "deepseek-v4-flash", category, reason: category };
}
