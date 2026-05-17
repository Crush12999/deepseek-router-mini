import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTING_CONFIG,
  calculateModelCost,
  filterByExcludeList,
  getFallbackChain,
  route,
} from "../src/router/index.js";
import type { ModelPricing, RouterOptions, RoutingConfig, Tier, TierConfig } from "../src/router/index.js";

const pricing: Map<string, ModelPricing> = new Map([
  ["flash", { inputPrice: 0.28, outputPrice: 0.42 }],
  ["pro", { inputPrice: 0.56, outputPrice: 1.68 }],
]);

const TEST_TIERS: Record<Tier, TierConfig> = {
  SIMPLE: { primary: "flash", fallback: [] },
  MEDIUM: { primary: "flash", fallback: ["pro"] },
  COMPLEX: { primary: "pro", fallback: [] },
  REASONING: { primary: "pro", fallback: [] },
};

const TEST_CONFIG: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  tiers: TEST_TIERS,
};

function options(overrides: Partial<RouterOptions> = {}): RouterOptions {
  return {
    config: TEST_CONFIG,
    modelPricing: pricing,
    ...overrides,
  };
}

const expectedRemovedRoutingFields = [
  "agenticTiers",
  "classifier",
  "ecoTiers",
  "premiumTiers",
] as const;

const representativeScoringKeywords = [
  ["codeKeywords", "インポート"],
  ["reasoningKeywords", "цепочка рассуждений"],
  ["simpleKeywords", "да или нет"],
  ["technicalKeywords", "خوارزمية"],
  ["creativeKeywords", "мозговой штурм"],
  ["imperativeVerbs", "развернуть"],
  ["constraintIndicators", "على الأكثر"],
  ["outputFormatKeywords", "جدول"],
  ["referenceKeywords", "أعلاه"],
  ["negationKeywords", "لا تفعل"],
  ["domainSpecificKeywords", "جينوميات"],
  ["agenticTaskKeywords", "قراءة ملف"],
] as const;

const deprecatedCodeKeywords = ["debug", "fix", "refactor"] as const;

describe("smart router", () => {
  it("routes simple prompts to the flash public model", () => {
    const decision = route("Summarize Redis in one paragraph.", undefined, 512, options());

    expect(decision.publicModel).toBe("flash");
    expect(decision.tier).toBe("SIMPLE");
    expect(decision.profile).toBe("default");
    expect(decision.tierConfigs).toBe(TEST_TIERS);
  });

  it("routes reasoning prompts to the pro public model", () => {
    const decision = route(
      "Prove this theorem step by step and derive the result formally.",
      undefined,
      1024,
      options(),
    );

    expect(decision.publicModel).toBe("pro");
    expect(["COMPLEX", "REASONING"]).toContain(decision.tier);
    expect(decision.reasoning).toContain("reasoning");
  });

  it("keeps agentic signals without switching tier profiles", () => {
    const decision = route(
      "Read the file and summarize the config.",
      undefined,
      2048,
      options(),
    );

    expect(decision.publicModel).toBe("flash");
    expect(decision.profile).toBe("default");
    expect(decision.tierConfigs).toBe(TEST_TIERS);
    expect(decision.agenticScore).toBeGreaterThan(0);
    expect(decision.score).toEqual(expect.any(Number));
  });

  it("does not force ordinary structured output requests to pro", () => {
    const decision = route(
      "Summarize Redis briefly.",
      "Return a strict JSON object matching the schema.",
      512,
      options(),
    );

    expect(decision.publicModel).toBe("flash");
    expect(decision.tier).toBe("MEDIUM");
    expect(decision.reasoning).toContain("structured output");
  });

  it("does not force pro only because the prompt is long", () => {
    const longPrompt = "Summarize this long transcript.\n" + "a".repeat(128_001 * 4);
    const decision = route(longPrompt, undefined, 512, options());

    expect(decision.publicModel).toBe("flash");
    expect(decision.tier).toBe("MEDIUM");
    expect(decision.reasoning).not.toContain("128000 tokens");
  });

  it("scores the fifteenth agenticTask dimension", () => {
    const decision = route(
      "Read the file, edit src/router.ts, npm test, fix failures, and verify the result.",
      undefined,
      2048,
      options(),
    );

    expect(decision.agenticScore).toBeGreaterThan(0);
    expect(decision.reasoning).toMatch(/agentic/i);
    expect(decision.profile).toBe("default");
  });

  it("exposes fallback chain helpers using public model ids", () => {
    expect(getFallbackChain("MEDIUM", TEST_TIERS)).toEqual(["flash", "pro"]);
  });

  it("exposes exclude-list filtering with safe fallback behavior", () => {
    const chain = ["flash", "pro"];

    expect(filterByExcludeList(chain, new Set(["flash"]))).toEqual(["pro"]);
    expect(filterByExcludeList(chain, new Set(chain))).toEqual(chain);
  });

  it("calculates cost relative to the pro baseline", () => {
    const cost = calculateModelCost("flash", pricing, 1_000_000, 1_000_000, "pro");

    expect(cost.costEstimate).toBeCloseTo(0.7);
    expect(cost.baselineCost).toBeCloseTo(2.24);
    expect(cost.savings).toBeGreaterThan(0);
  });

  it("removes deprecated routing config and profile compatibility fields", () => {
    expect(DEFAULT_ROUTING_CONFIG.scoring.dimensionWeights).not.toHaveProperty(
      "codebaseDebugging",
    );
    for (const field of expectedRemovedRoutingFields) {
      expect(DEFAULT_ROUTING_CONFIG, `expected ${field} to be removed`).not.toHaveProperty(
        field,
      );
    }
    expect(DEFAULT_ROUTING_CONFIG.overrides).toEqual({
      structuredOutputMinTier: "MEDIUM",
      ambiguousDefaultTier: "MEDIUM",
    });
  });

  it("keeps representative 15-dimension scoring keywords and thresholds aligned", () => {
    for (const [keywordGroup, keyword] of representativeScoringKeywords) {
      expect(
        DEFAULT_ROUTING_CONFIG.scoring[keywordGroup],
        `expected ${keywordGroup} to include ${keyword}`,
      ).toContain(keyword);
    }
    for (const keyword of deprecatedCodeKeywords) {
      expect(
        DEFAULT_ROUTING_CONFIG.scoring.codeKeywords,
        `expected codeKeywords to drop deprecated token ${keyword}`,
      ).not.toContain(keyword);
    }
    expect(DEFAULT_ROUTING_CONFIG.scoring.tokenCountThresholds).toEqual({
      simple: 50,
      complex: 500,
    });
    expect(DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries).toMatchObject({
      simpleMedium: 0,
      mediumComplex: 0.3,
      complexReasoning: 0.5,
    });
    expect(DEFAULT_ROUTING_CONFIG.scoring.confidenceThreshold).toBe(0.7);
  });
});
