import { describe, expect, it } from "vitest";

describe("models module", () => {
  it("does not expose legacy runtime model helpers", async () => {
    const modelsModule = await import("../src/models.js");

    expect(Object.keys(modelsModule)).toEqual([]);
    expect("MODEL_ROLES" in modelsModule).toBe(false);
    expect("XIAOYI_MODELS" in modelsModule).toBe(false);
    expect("getDefaultModelForRole" in modelsModule).toBe(false);
    expect("getModel" in modelsModule).toBe(false);
    expect("isRealModel" in modelsModule).toBe(false);
    expect("supportsVision" in modelsModule).toBe(false);
    expect("getModelPricing" in modelsModule).toBe(false);
  });
});
