import { describe, it, expect } from "vitest";
import {
  resolvePublicModel,
  resolvePublicModelCandidate,
} from "../src/public-model-resolver.js";
import { createModelRegistry } from "../src/model-registry.js";
import type { PhysicalModel, PublicModelConfig } from "../src/config-schema.js";

describe("resolvePublicModel", () => {
  const models: PhysicalModel[] = [
    {
      id: "cheap",
      name: "Cheap",
      inputPrice: 0.1,
      outputPrice: 0.2,
      contextWindow: 100000,
      maxOutput: 4000,
      reasoning: false,
      toolCalling: true,
    },
    {
      id: "expensive",
      name: "Expensive",
      inputPrice: 0.5,
      outputPrice: 1.0,
      contextWindow: 100000,
      maxOutput: 4000,
      reasoning: true,
      toolCalling: true,
    },
  ];
  const registry = createModelRegistry(models);

  it("should resolve cheapest model by default", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      flash: { kind: "alias", candidates: ["expensive", "cheap"] },
    };
    const result = resolvePublicModel("flash", publicModels, registry);
    expect(result).toBe("cheap");
    expect(resolvePublicModelCandidate("flash", publicModels, registry)).toMatchObject({
      id: "cheap",
      inputPrice: 0.1,
      outputPrice: 0.2,
    });
  });

  it("should resolve first model when selection=first", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      flash: { kind: "alias", candidates: ["expensive", "cheap"], selection: "first" },
    };
    const result = resolvePublicModel("flash", publicModels, registry);
    expect(result).toBe("expensive");
    expect(resolvePublicModelCandidate("flash", publicModels, registry)).toMatchObject({
      id: "expensive",
      inputPrice: 0.5,
      outputPrice: 1,
    });
  });

  it("should throw for unknown public model", () => {
    expect(() => resolvePublicModel("unknown", {}, registry)).toThrow(/unknown public model/i);
  });

  it("should throw for router kind", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      auto: {
        kind: "router",
        metadata: {
          name: "Auto",
          reasoning: true,
          contextWindow: 100000,
          maxTokens: 4000,
          cost: {
            input: 0.1,
            output: 0.2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    };
    expect(() => resolvePublicModel("auto", publicModels, registry)).toThrow(/cannot resolve router/i);
  });

  it("should throw for empty candidates list", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      empty: { kind: "alias", candidates: [] },
    };
    expect(() => resolvePublicModel("empty", publicModels, registry)).toThrow(/no candidates available/i);
  });

  it("should throw for invalid candidate model ID", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      invalid: { kind: "alias", candidates: ["cheap", "nonexistent"] },
    };
    expect(() => resolvePublicModel("invalid", publicModels, registry)).toThrow(/candidate model not found.*nonexistent/i);
  });

  it("should resolve single candidate model", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      single: { kind: "alias", candidates: ["cheap"] },
    };
    const result = resolvePublicModel("single", publicModels, registry);
    expect(result).toBe("cheap");
  });

  it("should throw candidate resolution for unknown public model", () => {
    expect(() => resolvePublicModelCandidate("unknown", {}, registry)).toThrow(/unknown public model/i);
  });

  it("should throw candidate resolution for router kind", () => {
    const publicModels: Record<string, PublicModelConfig> = {
      auto: {
        kind: "router",
        metadata: {
          name: "auto",
          reasoning: true,
          contextWindow: 100000,
          maxTokens: 4000,
          cost: {
            input: 0.1,
            output: 0.2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
    };
    expect(() => resolvePublicModelCandidate("auto", publicModels, registry)).toThrow(/cannot resolve router/i);
  });
});
