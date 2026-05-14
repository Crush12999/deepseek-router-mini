import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config-loader.js";
import { createModelRegistry } from "../src/model-registry.js";
import { resolvePublicModel } from "../src/public-model-resolver.js";

// 生成 100 个模型的配置
const largeConfig = {
  version: 1,
  proxy: { port: 8402, upstreamUrl: "https://api.test.com" },
  models: Array.from({ length: 100 }, (_, i) => ({
    id: `model-${i}`,
    upstreamModel: `model-${i}`,
    name: `Model ${i}`,
    inputPrice: Math.random(),
    outputPrice: Math.random(),
    contextWindow: 100000,
    maxOutput: 4000,
    reasoning: false,
    toolCalling: true,
  })),
  publicModels: {
    auto: { kind: "router" as const },
    flash: { kind: "alias" as const, candidates: ["model-0", "model-1", "model-2"] },
  },
  routing: {
    tiers: {
      SIMPLE: { publicModel: "flash" },
      MEDIUM: { publicModel: "flash" },
      COMPLEX: { publicModel: "flash" },
      REASONING: { publicModel: "flash" },
    },
    tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
    confidenceThreshold: 0.7,
    structuredOutputMinTier: "MEDIUM" as const,
    ambiguousDefaultTier: "MEDIUM" as const,
  },
};

// Benchmark 1: 加载配置
const start1 = performance.now();
const config = loadConfig({ kind: "inline", config: largeConfig as any });
const end1 = performance.now();
console.log(`Load 100-model config: ${(end1 - start1).toFixed(2)}ms`);

// Benchmark 2: 创建注册表
const start2 = performance.now();
const registry = createModelRegistry(config.models);
const end2 = performance.now();
console.log(`Create registry (100 models): ${(end2 - start2).toFixed(2)}ms`);

// Benchmark 3: 1000 次解析
const start3 = performance.now();
for (let i = 0; i < 1000; i++) {
  resolvePublicModel("flash", config.publicModels, registry);
}
const end3 = performance.now();
console.log(`1000 resolvePublicModel calls: ${(end3 - start3).toFixed(2)}ms`);
