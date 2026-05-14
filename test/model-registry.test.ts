import { describe, it, expect } from "vitest";
import { createModelRegistry } from "../src/model-registry.js";
import type { PhysicalModel } from "../src/config-schema.js";

describe("ModelRegistry", () => {
  const models: PhysicalModel[] = [
    {
      id: "model-a",
      upstreamModel: "upstream-a",
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
});
