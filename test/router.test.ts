import { describe, expect, it } from "vitest";

import { MODEL_ROLES } from "../src/models.js";
import { classifyPrompt } from "../src/router/classifier.js";
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
import { selectModel } from "../src/router/selector.js";
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

  it("routes tool and agentic requests through agentic tiers", () => {
    const decision = route(
      "Edit src/router/index.ts, run npm test, and verify the fix.",
      undefined,
      2048,
      options({ hasTools: true }),
    );

    expect(decision.model).toBe(MODEL_ROLES.agentic);
    expect(decision.profile).toBe("agentic");
    expect(decision.tierConfigs).toBe(DEFAULT_ROUTING_CONFIG.agenticTiers);
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
    const cost = calculateModelCost(MODEL_ROLES.light, pricing, 1_000_000, 1_000_000, "auto");

    expect(cost.costEstimate).toBeCloseTo(0.7);
    expect(cost.baselineCost).toBeCloseTo(2.24);
    expect(cost.savings).toBeGreaterThan(0);
  });
});

describe("legacy router compatibility", () => {
  it("keeps legacy selectModel(input) for proxy auto routing", () => {
    expect(selectModel({ prompt: "Write a TypeScript function and use the tool", hasTools: true })).toMatchObject({
      model: MODEL_ROLES.strong,
      category: "code",
      reason: "tools",
    });
  });

  it("does not let ambient tools override simple legacy routing", () => {
    expect(classifyPrompt("Summarize briefly: OpenClaw routes simple tasks.")).toBe("simple");
    expect(selectModel({ prompt: "Summarize briefly: OpenClaw routes simple tasks.", hasTools: true })).toMatchObject({
      model: MODEL_ROLES.light,
      category: "simple",
      reason: "simple",
    });
  });
});
