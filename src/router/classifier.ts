import { CODE_PATTERNS, COMPLEX_PATTERNS, SIMPLE_PATTERNS } from "./rules.js";
import type { TaskCategory } from "./types.js";

function matchesAny(prompt: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(prompt));
}

export function classifyPrompt(prompt: string, systemPrompt = ""): TaskCategory {
  const text = `${systemPrompt}\n${prompt}`.trim();
  if (!text) return "simple";
  if (matchesAny(text, COMPLEX_PATTERNS)) return "complex";
  if (matchesAny(text, CODE_PATTERNS)) return "code";
  if (matchesAny(text, SIMPLE_PATTERNS)) return "simple";
  return "standard";
}
