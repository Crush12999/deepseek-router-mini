import { getStrategy } from "./strategy.js";
import type { RouterOptions, RoutingDecision } from "./types.js";

export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  return getStrategy("rules").route(
    prompt,
    systemPrompt,
    maxOutputTokens,
    options,
  );
}

export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export { getStrategy, registerStrategy, RulesStrategy } from "./strategy.js";
export {
  calculateModelCost,
  filterByExcludeList,
  getFallbackChain,
  selectModel,
} from "./selector.js";
export {
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
  resolveTraceWriter,
} from "./trace.js";
export type {
  OverridesConfig,
  RouterOptions,
  RouterStrategy,
  RoutingConfig,
  RoutingDecision,
  ScoringConfig,
  ScoringResult,
  Tier,
  TierConfig,
} from "./types.js";
export type { ModelPricing } from "./selector.js";
export type {
  RouteTraceLog,
  TraceAttempt,
  TraceLogger,
  TraceMode,
  TraceReason,
  TraceSessionAction,
  TraceSummaryInput,
  TraceWriter,
} from "./trace.js";
