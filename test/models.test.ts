import { describe, expect, it } from "vitest";

import {
  MODEL_ROLES,
  SUPPORTED_MODEL_IDS,
  XIAOYI_MODELS,
  type XiaoyiModel,
  getDefaultModelForRole,
  getModel,
  getModelPricing,
  isRealModel,
  validateModelId,
} from "../src/models.js";

describe("xiaoyi model registry", () => {
  it("keeps model ids centralized and unique", () => {
    expect(SUPPORTED_MODEL_IDS).toEqual(["auto", "deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(XIAOYI_MODELS.map((model) => model.id)).toEqual(SUPPORTED_MODEL_IDS);
    expect(new Set(XIAOYI_MODELS.map((model) => model.id)).size).toBe(SUPPORTED_MODEL_IDS.length);
  });

  it("exports xiaoyi public model symbols without legacy aliases", async () => {
    const modelsModule = await import("../src/models.js");

    expect(modelsModule.XIAOYI_MODELS).toBe(XIAOYI_MODELS);
    expect(modelsModule.XIAOYI_MODELS satisfies XiaoyiModel[]).toBe(modelsModule.XIAOYI_MODELS);
    expect("DEEPSEEK_MODELS" in modelsModule).toBe(false);
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
    expect(validateModelId("auto")).toEqual({ ok: true, model: "auto" });
    expect(validateModelId("deepseek-v4-flash")).toEqual({ ok: true, model: "deepseek-v4-flash" });
    expect(validateModelId("deepseek-v4-pro")).toEqual({ ok: true, model: "deepseek-v4-pro" });
    expect(validateModelId("flash").ok).toBe(false);
    expect(validateModelId("pro").ok).toBe(false);
    expect(validateModelId("openai/gpt-5.5").ok).toBe(false);
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
