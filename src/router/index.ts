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
  filterByToolCalling,
  filterByVision,
  getFallbackChain,
  getFallbackChainFiltered,
  selectModel,
} from "./selector.js";
export {
  buildTraceSummary,
  emitRouteTrace,
  getPromptPreview,
  normalizeTraceMode,
} from "./trace.js";
export type {
  ClassifierConfig,
  OverridesConfig,
  RouteDecision,
  RouteInput,
  RouterOptions,
  RouterStrategy,
  RoutingConfig,
  RoutingDecision,
  ScoringConfig,
  ScoringResult,
  TaskCategory,
  Tier,
  TierConfig,
} from "./types.js";
export type { ModelPricing } from "./selector.js";
export type {
  RouteTraceLog,
  TraceAttempt,
  TraceMode,
  TraceReason,
  TraceSessionAction,
  TraceSummaryInput,
} from "./trace.js";
