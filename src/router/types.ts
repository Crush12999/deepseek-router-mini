import type { Tier } from "../config-schema.js";
import type { ModelPricing } from "./selector.js";

export type { Tier } from "../config-schema.js";

export type ScoringResult = {
  score: number;
  tier: Tier | null;
  confidence: number;
  signals: string[];
  agenticScore?: number;
  dimensions?: Array<{ name: string; score: number; signal: string | null }>;
};

export type RoutingDecision = {
  publicModel: string;
  tier: Tier;
  confidence: number;
  method: "rules" | "llm";
  reasoning: string;
  score?: number;
  costEstimate: number;
  baselineCost: number;
  savings: number;
  agenticScore?: number;
  tierConfigs?: Record<Tier, TierConfig>;
  profile?: "default";
};

export interface RouterStrategy {
  readonly name: string;
  route(
    prompt: string,
    systemPrompt: string | undefined,
    maxOutputTokens: number,
    options: RouterOptions,
  ): RoutingDecision;
}

export type RouterOptions = {
  strategy?: string;
  config?: RoutingConfig;
  modelPricing?: Map<string, ModelPricing>;
};

export type TierConfig = {
  primary: string;
  fallback: string[];
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
  imperativeVerbs: string[];
  constraintIndicators: string[];
  outputFormatKeywords: string[];
  referenceKeywords: string[];
  negationKeywords: string[];
  domainSpecificKeywords: string[];
  agenticTaskKeywords: string[];
  dimensionWeights: Record<string, number>;
  tierBoundaries: {
    simpleMedium: number;
    mediumComplex: number;
    complexReasoning: number;
  };
  confidenceSteepness: number;
  confidenceThreshold: number;
};

export type OverridesConfig = {
  structuredOutputMinTier?: Tier;
  ambiguousDefaultTier?: Tier;
};

export type RoutingConfig = {
  version: string;
  scoring: ScoringConfig;
  tiers?: Record<Tier, TierConfig>;
  overrides?: OverridesConfig;
};
