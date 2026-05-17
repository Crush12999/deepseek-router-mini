import { describe, it, expect } from "vitest";
import { createModelRegistry } from "../src/model-registry.js";
import type { PhysicalModel } from "../src/config-schema.js";

describe("ModelRegistry", () => {
  const models: PhysicalModel[] = [
    {
      id: "model-a",
      name: "Model A",
      inputPrice: 0.1,
      outputPrice: 0.2,
      contextWindow: 100000,
      maxOutput: 4000,
      reasoning: false,
      toolCalling: true,
    },
  ];

  it("should create registry from models", () => {
    const registry = createModelRegistry(models);
    expect(registry.get("model-a")).toEqual(models[0]);
  });

  it("should reject duplicate model IDs", () => {
    const duplicates = [...models, models[0]!];
    expect(() => createModelRegistry(duplicates)).toThrow(/duplicate.*model-a/i);
  });

  it("should return undefined for unknown model", () => {
    const registry = createModelRegistry(models);
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("should check if model exists with has()", () => {
    const registry = createModelRegistry(models);
    expect(registry.has("model-a")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
  });

  it("should return all models with all()", () => {
    const registry = createModelRegistry(models);
    expect(registry.all()).toEqual(models);
  });

  it("should handle empty model list", () => {
    const registry = createModelRegistry([]);
    expect(registry.all()).toEqual([]);
    expect(registry.has("any")).toBe(false);
    expect(registry.get("any")).toBeUndefined();
  });

  it("should protect registry from mutation via all()", () => {
    const registry = createModelRegistry(models);
    const allModels = registry.all();

    // 修改返回的数组中的对象
    allModels[0]!.inputPrice = 999;

    // 注册表内部数据不应被污染
    expect(registry.get("model-a")?.inputPrice).toBe(0.1);
  });

  it("should protect registry from mutation via get()", () => {
    const registry = createModelRegistry(models);
    const model = registry.get("model-a");

    // 修改返回的对象
    if (model) {
      model.outputPrice = 888;
    }

    // 注册表内部数据不应被污染
    expect(registry.get("model-a")?.outputPrice).toBe(0.2);
  });
});
