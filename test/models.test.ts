import { describe, expect, it } from "vitest";

import {
  MODEL_ROLES,
  XIAOYI_MODELS,
  type XiaoyiModel,
  getDefaultModelForRole,
  getModel,
  getModelPricing,
  isRealModel,
} from "../src/models.js";

const legacyExport = (name: string) => ["DEEPSEEK", name].join("_");

describe("xiaoyi model registry", () => {
  it("keeps model ids centralized and unique", () => {
    const modelIds = XIAOYI_MODELS.map((model) => model.id);
    expect(modelIds).toEqual(["auto", "deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(new Set(modelIds).size).toBe(XIAOYI_MODELS.length);
  });

  it("exports xiaoyi public model symbols without legacy aliases", async () => {
    const modelsModule = await import("../src/models.js");

    expect(modelsModule.XIAOYI_MODELS).toBe(XIAOYI_MODELS);
    expect(modelsModule.XIAOYI_MODELS satisfies XiaoyiModel[]).toBe(modelsModule.XIAOYI_MODELS);
    expect(legacyExport("MODELS") in modelsModule).toBe(false);
    expect("DeepSeekModel" in modelsModule).toBe(false);
  });

  it("derives each model role list from the canonical role mapping", () => {
    expect(MODEL_ROLES).toEqual({
      auto: "auto",
      light: "deepseek-v4-flash",
      strong: "deepseek-v4-pro",
      reasoning: "deepseek-v4-pro",
      agentic: "deepseek-v4-pro",
    });

    const rolesByModel = Object.entries(MODEL_ROLES).reduce<Record<string, string[]>>((acc, [role, modelId]) => {
      acc[modelId] ??= [];
      acc[modelId].push(role);
      return acc;
    }, {});

    for (const model of XIAOYI_MODELS) {
      expect(model.roles).toEqual(rolesByModel[model.id]);
    }

    expect(getDefaultModelForRole("auto")).toBe("auto");
    expect(getDefaultModelForRole("light")).toBe("deepseek-v4-flash");
    expect(getDefaultModelForRole("strong")).toBe("deepseek-v4-pro");
    expect(getDefaultModelForRole("reasoning")).toBe("deepseek-v4-pro");
    expect(getDefaultModelForRole("agentic")).toBe("deepseek-v4-pro");
  });

  it("validates supported model ids", () => {
    expect(getModel("auto")).toBeDefined();
    expect(getModel("deepseek-v4-flash")).toBeDefined();
    expect(getModel("deepseek-v4-pro")).toBeDefined();
    expect(getModel("flash")).toBeUndefined();
    expect(getModel("pro")).toBeUndefined();
    expect(getModel("openai/gpt-5.5")).toBeUndefined();
  });

  it("exposes model metadata without callers hardcoding ids", () => {
    const flashModel = getModel(getDefaultModelForRole("light"));
    const proModel = getModel(getDefaultModelForRole("strong"));

    expect(isRealModel("auto")).toBe(false);
    expect(isRealModel(flashModel!.id)).toBe(true);
    expect(isRealModel(proModel!.id)).toBe(true);
    expect(flashModel).toMatchObject({
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      inputPrice: 0.28,
      outputPrice: 0.42,
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      reasoning: true,
      toolCalling: true,
      roles: ["light"],
    });
    expect(proModel).toMatchObject({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      inputPrice: 0.56,
      outputPrice: 1.68,
      contextWindow: 1_000_000,
      maxOutput: 64_000,
      reasoning: true,
      toolCalling: true,
      roles: ["strong", "reasoning", "agentic"],
    });
    expect(getModelPricing(flashModel!.id)).toEqual({ inputPrice: 0.28, outputPrice: 0.42 });
    expect(getModelPricing(proModel!.id)).toEqual({ inputPrice: 0.56, outputPrice: 1.68 });
    expect(getModelPricing(proModel!.id).outputPrice).toBeGreaterThan(
      getModelPricing(flashModel!.id).outputPrice,
    );
  });

  it("rejects unknown model ids before returning pricing", () => {
    expect(getModel("does-not-exist")).toBeUndefined();
    expect(() => getModelPricing("does-not-exist")).toThrowError(
      'Unsupported model "does-not-exist". Supported models: auto, deepseek-v4-flash, deepseek-v4-pro',
    );
  });
});
