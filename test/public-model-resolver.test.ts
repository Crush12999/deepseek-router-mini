import { describe, it, expect } from "vitest";
import { resolvePublicModel } from "../src/public-model-resolver.js";
import { createModelRegistry } from "../src/model-registry.js";
import type { PhysicalModel, PublicModelConfig } from "../src/config-schema.js";

describe("resolvePublicModel", () => {
  const models: PhysicalModel[] = [
    { id: "cheap", upstreamModel: "cheap", name: "Cheap", inputPrice: 0.1, outputPrice: 0.2, contextWindow: 100000, maxOutput: 4000, reasoning: false, toolCalling: true },
    { id: "expensive", upstreamModel: "expensive", name: "Expensive", inputPrice: 0.5, outputPrice: 1.0, contextWindow: 100000, maxOutput: 4000, reasoning: true, toolCalling: true },
  ];
  const registry = createModelRegistry(models);

  it("should resolve cheapest model by default", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      flash: { kind: "alias", candidates: ["expensive", "cheap"] },
    };
    const result = resolvePublicModel("flash", publicModels, registry);
    expect(result).toBe("cheap");
  });

  it("should resolve first model when selection=first", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      flash: { kind: "alias", candidates: ["expensive", "cheap"], selection: "first" },
    };
    const result = resolvePublicModel("flash", publicModels, registry);
    expect(result).toBe("expensive");
  });

  it("should throw for unknown public model", () => {
    expect(() => resolvePublicModel("unknown", {}, registry)).toThrow(/unknown public model/i);
  });

  it("should throw for router kind", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      auto: { kind: "router" },
    };
    expect(() => resolvePublicModel("auto", publicModels, registry)).toThrow(/cannot resolve router/i);
  });
});
