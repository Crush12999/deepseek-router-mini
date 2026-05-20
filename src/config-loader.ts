import { readFileSync } from "node:fs";
import type { ConfigSource, RawConfig } from "./config-schema.js";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (!isFiniteNumber(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function assertPublicModelMetadata(value: unknown, path: string): void {
  if (!value || typeof value !== "object") {
    throw new Error(`${path}.metadata is required`);
  }

  const metadata = value as Record<string, unknown>;
  const metadataPath = `${path}.metadata`;

  for (const key of [
    "name",
    "reasoning",
    "contextWindow",
    "maxTokens",
    "cost",
  ]) {
    if (!hasOwn(metadata, key)) {
      throw new Error(`${metadataPath}.${key} is required`);
    }
  }

  if (typeof metadata.name !== "string") {
    throw new Error(`${metadataPath}.name must be a string`);
  }

  if (typeof metadata.reasoning !== "boolean") {
    throw new Error(`${metadataPath}.reasoning must be a boolean`);
  }

  if (typeof metadata.contextWindow !== "number") {
    throw new Error(`${metadataPath}.contextWindow must be a number`);
  }

  if (typeof metadata.maxTokens !== "number") {
    throw new Error(`${metadataPath}.maxTokens must be a number`);
  }

  if (!metadata.cost || typeof metadata.cost !== "object") {
    throw new Error(`${metadataPath}.cost must be an object`);
  }

  const cost = metadata.cost as Record<string, unknown>;
  const costPath = `${metadataPath}.cost`;

  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!hasOwn(cost, key)) {
      throw new Error(`${costPath}.${key} is required`);
    }
  }

  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof cost[key] !== "number") {
      throw new Error(`${costPath}.${key} must be a number`);
    }
  }
}

function assertAliasPublicModel(
  publicModels: RawConfig["publicModels"],
  id: string,
  path: string,
): void {
  const publicModel = publicModels[id];

  if (!publicModel) {
    throw new Error(`${path} references unknown publicModel: ${id}`);
  }

  if (publicModel.kind !== "alias") {
    throw new Error(`${path} must reference a publicModel with kind: "alias"`);
  }
}

/**
 * 加载并校验配置文件
 * @param source 配置源：内联对象或文件路径
 * @returns 校验通过的配置对象
 * @throws {Error} 如果配置不合法（重复 ID、引用不存在、缺少 auto 等）
 */
export function loadConfig(source: ConfigSource): RawConfig {
  const raw =
    source.kind === "inline"
      ? source.config
      : JSON.parse(readFileSync(source.path, "utf-8"));
  validateConfig(raw);
  return raw;
}

/**
 * 校验配置完整性和引用关系
 *
 * 校验项：
 * - models[].id 唯一性
 * - publicModels.auto 必须是 router 且 metadata 完整
 * - publicModels[*].candidates[] 引用必须在 models 中存在
 * - publicModels[*].candidates[] 非空（仅 alias）
 * - routing.tiers[*].publicModel / fallback[] 只能引用 alias publicModel
 * - 四个 tier 必须完整声明
 * - proxy.port 是 1-65535 整数
 * - proxy.headers 值都是字符串
 *
 * @param config 待校验的配置对象
 * @throws {Error} 如果校验失败，错误信息包含具体字段和期望值
 */
function validateConfig(config: RawConfig): void {
  const modelIds = new Set<string>();

  for (const model of config.models) {
    if (modelIds.has(model.id)) {
      throw new Error(`Duplicate model ID: ${model.id}`);
    }

    modelIds.add(model.id);
  }

  const auto = config.publicModels.auto;
  if (!auto || auto.kind !== "router") {
    throw new Error('publicModels must contain "auto" with kind: "router"');
  }
  assertPublicModelMetadata(auto.metadata, "publicModels.auto");

  for (const [publicModelId, publicModel] of Object.entries(
    config.publicModels,
  )) {
    if (publicModel.kind === "router") {
      if (publicModelId !== "auto") {
        throw new Error(
          `publicModels.${publicModelId}: only auto may use kind: "router"`,
        );
      }
      assertPublicModelMetadata(
        publicModel.metadata,
        `publicModels.${publicModelId}`,
      );
      continue;
    }

    if (
      !Array.isArray(publicModel.candidates) ||
      publicModel.candidates.length === 0
    ) {
      throw new Error(
        `publicModels.${publicModelId}.candidates must not be empty`,
      );
    }

    for (const candidate of publicModel.candidates) {
      if (!modelIds.has(candidate)) {
        throw new Error(
          `Unknown candidate '${candidate}' in publicModels.${publicModelId}`,
        );
      }
    }

    if (publicModel.metadata != null) {
      assertPublicModelMetadata(
        publicModel.metadata,
        `publicModels.${publicModelId}`,
      );
    }
  }

  for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const) {
    if (!config.routing.tiers[tier]) {
      throw new Error(`routing.tiers.${tier} is required`);
    }
  }

  for (const [tier, tierConfig] of Object.entries(config.routing.tiers)) {
    assertAliasPublicModel(
      config.publicModels,
      tierConfig.publicModel,
      `routing.tiers.${tier}.publicModel`,
    );

    for (const fallbackId of tierConfig.fallback ?? []) {
      assertAliasPublicModel(
        config.publicModels,
        fallbackId,
        `routing.tiers.${tier}.fallback`,
      );
    }
  }

  if (hasOwn(config.routing as object, "tierBoundaries")) {
    const tierBoundaries = config.routing.tierBoundaries;

    if (
      !tierBoundaries ||
      typeof tierBoundaries !== "object" ||
      Array.isArray(tierBoundaries)
    ) {
      throw new Error("routing.tierBoundaries must be an object");
    }

    const { simpleMedium, mediumComplex, complexReasoning } = tierBoundaries;

    assertFiniteNumber(simpleMedium, "routing.tierBoundaries.simpleMedium");
    assertFiniteNumber(mediumComplex, "routing.tierBoundaries.mediumComplex");
    assertFiniteNumber(
      complexReasoning,
      "routing.tierBoundaries.complexReasoning",
    );

    if (!(simpleMedium <= mediumComplex && mediumComplex <= complexReasoning)) {
      throw new Error(
        "routing.tierBoundaries must satisfy simpleMedium <= mediumComplex <= complexReasoning",
      );
    }
  }

  if (hasOwn(config.routing as object, "confidenceThreshold")) {
    assertFiniteNumber(
      config.routing.confidenceThreshold,
      "routing.confidenceThreshold",
    );

    if (
      config.routing.confidenceThreshold < 0 ||
      config.routing.confidenceThreshold > 1
    ) {
      throw new Error("routing.confidenceThreshold must be between 0 and 1");
    }
  }

  if (
    !Number.isInteger(config.proxy.port) ||
    config.proxy.port < 1 ||
    config.proxy.port > 65535
  ) {
    throw new Error(
      `proxy.port must be an integer between 1-65535, got: ${config.proxy.port}`,
    );
  }

  if (
    typeof config.proxy.upstreamUrl !== "string" ||
    config.proxy.upstreamUrl.trim().length === 0
  ) {
    throw new Error("proxy.upstreamUrl must be a non-empty string");
  }

  if (config.proxy.headers) {
    for (const [key, value] of Object.entries(config.proxy.headers)) {
      if (typeof value !== "string") {
        throw new Error(
          `proxy.headers['${key}'] must be a string, got: ${typeof value}`,
        );
      }
    }
  }
}
