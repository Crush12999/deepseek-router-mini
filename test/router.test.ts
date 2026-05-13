import { describe, expect, it } from "vitest";

import { MODEL_ROLES } from "../src/models.js";
import {
  DEFAULT_ROUTING_CONFIG,
  calculateModelCost,
  filterByExcludeList,
  filterByToolCalling,
  filterByVision,
  getFallbackChain,
  getFallbackChainFiltered,
  route,
} from "../src/router/index.js";
import type { ModelPricing, RouterOptions } from "../src/router/index.js";

const pricing: Map<string, ModelPricing> = new Map([
  [MODEL_ROLES.light, { inputPrice: 0.28, outputPrice: 0.42 }],
  [MODEL_ROLES.strong, { inputPrice: 0.56, outputPrice: 1.68 }],
]);

function options(overrides: Partial<RouterOptions> = {}): RouterOptions {
  return {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing: pricing,
    ...overrides,
  };
}

const expectedRemovedRoutingFields = [
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
  it("routes simple prompts to the light model with the default medium tier", () => {
    const decision = route("Summarize Redis in one paragraph.", undefined, 512, options());

    expect(decision.model).toBe(MODEL_ROLES.light);
    expect(decision.tier).toBe("MEDIUM");
    expect(decision.profile).toBe("auto");
    expect(decision.tierConfigs).toBe(DEFAULT_ROUTING_CONFIG.tiers);
  });

  it("routes reasoning prompts to the strong model", () => {
    const decision = route(
      "Prove this theorem step by step and derive the result formally.",
      undefined,
      1024,
      options(),
    );

    expect(decision.model).toBe(MODEL_ROLES.strong);
    expect(["COMPLEX", "REASONING"]).toContain(decision.tier);
    expect(decision.reasoning).toContain("reasoning");
  });

  it("routes tool and lightweight agentic requests through agentic tiers without forcing pro", () => {
    const decision = route(
      "Read the file and summarize the config.",
      undefined,
      2048,
      options({ hasTools: true }),
    );

    expect(decision.model).toBe(MODEL_ROLES.light);
    expect(decision.profile).toBe("agentic");
    expect(decision.tierConfigs).toBe(DEFAULT_ROUTING_CONFIG.agenticTiers);
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

    expect(decision.model).toBe(MODEL_ROLES.light);
    expect(decision.tier).toBe("MEDIUM");
    expect(decision.reasoning).toContain("structured output");
  });

  it("does not force pro only because the prompt is long", () => {
    const longPrompt = "Summarize this long transcript.\n" + "a".repeat(128_001 * 4);
    const decision = route(longPrompt, undefined, 512, options());

    expect(decision.model).toBe(MODEL_ROLES.light);
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
    expect(decision.profile).toBe("agentic");
  });

  it("exposes fallback chain helpers", () => {
    expect(getFallbackChain("MEDIUM", DEFAULT_ROUTING_CONFIG.tiers)).toEqual([
      MODEL_ROLES.light,
      MODEL_ROLES.strong,
    ]);

    expect(
      getFallbackChainFiltered("MEDIUM", DEFAULT_ROUTING_CONFIG.tiers, 950_000, (model) =>
        model === MODEL_ROLES.light ? 1_000_000 : 2_000_000,
      ),
    ).toEqual([MODEL_ROLES.strong]);
  });

  it("exposes filter helpers with safe fallback behavior", () => {
    const chain = [MODEL_ROLES.light, MODEL_ROLES.strong];

    expect(filterByToolCalling(chain, true, (model) => model === MODEL_ROLES.strong)).toEqual([
      MODEL_ROLES.strong,
    ]);
    expect(filterByToolCalling(chain, false, () => false)).toEqual(chain);
    expect(filterByVision(chain, true, () => false)).toEqual(chain);
    expect(filterByExcludeList(chain, new Set([MODEL_ROLES.light]))).toEqual([
      MODEL_ROLES.strong,
    ]);
    expect(filterByExcludeList(chain, new Set(chain))).toEqual(chain);
  });

  it("calculates cost relative to the strong baseline", () => {
    const cost = calculateModelCost(MODEL_ROLES.light, pricing, 1_000_000, 1_000_000);

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
    expect(DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries).toMatchObject({
      simpleMedium: 0,
      mediumComplex: 0.3,
      complexReasoning: 0.5,
    });
    expect(DEFAULT_ROUTING_CONFIG.scoring.confidenceThreshold).toBe(0.7);
  });
});
