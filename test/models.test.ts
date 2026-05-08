import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_MODELS,
  getModel,
  isRealModel,
  validateModelId,
} from "../src/models.js";

describe("models", () => {
  it("contains only auto, flash, and pro", () => {
    expect(DEEPSEEK_MODELS.map((model) => model.id)).toEqual([
      "auto",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("validates supported model IDs", () => {
    expect(validateModelId("auto")).toEqual({ ok: true, model: "auto" });
    expect(validateModelId("deepseek-v4-flash")).toEqual({
      ok: true,
      model: "deepseek-v4-flash",
    });
    expect(validateModelId("deepseek-v4-pro")).toEqual({
      ok: true,
      model: "deepseek-v4-pro",
    });
    expect(validateModelId("flash").ok).toBe(false);
    expect(validateModelId("openai/gpt-5.5").ok).toBe(false);
    expect(validateModelId("").ok).toBe(false);
  });

  it("identifies real upstream models", () => {
    expect(isRealModel("auto")).toBe(false);
    expect(isRealModel("deepseek-v4-flash")).toBe(true);
    expect(isRealModel("deepseek-v4-pro")).toBe(true);
  });

  it("exposes model metadata", () => {
    const flash = getModel("deepseek-v4-flash");
    const pro = getModel("deepseek-v4-pro");

    expect(flash?.reasoning).toBe(true);
    expect(flash?.toolCalling).toBe(true);
    expect(pro?.reasoning).toBe(true);
    expect(pro?.toolCalling).toBe(true);
    expect((pro?.outputPrice ?? 0) > (flash?.outputPrice ?? 0)).toBe(true);
  });
});
