import { readFileSync } from "node:fs";
import type { ConfigSource, RawConfig } from "./config-schema.js";

/**
 * 加载并校验配置文件
 * @param source 配置源：内联对象或文件路径
 * @returns 校验通过的配置对象
 * @throws {Error} 如果配置不合法（重复 ID、引用不存在、缺少 auto 等）
 */
export function loadConfig(source: ConfigSource): RawConfig {
  const raw = source.kind === "inline" ? source.config : JSON.parse(readFileSync(source.path, "utf-8"));
  validateConfig(raw);
  return raw;
}

/**
 * 校验配置完整性和引用关系
 *
 * 校验项：
 * - models[].id 唯一性
 * - publicModels 必含 "auto" 且 kind: "router"
 * - publicModels[*].candidates[] 引用必须在 models 中存在
 * - publicModels[*].candidates[] 非空（仅 alias）
 * - routing.tiers[*].publicModel 引用必须在 publicModels 中且 kind: "alias"
 * - routing.tiers[*].fallback[] 引用必须在 publicModels 中存在
 * - proxy.port 是 1-65535 整数
 * - proxy.headers 值都是字符串
 *
 * @param config 待校验的配置对象
 * @throws {Error} 如果校验失败，错误信息包含具体字段和期望值
 */
function validateConfig(config: RawConfig): void {
  // 检查 models[].id 唯一性
  const modelIds = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) {
      throw new Error(`Duplicate model ID: ${model.id}`);
    }
    modelIds.add(model.id);
  }

  // 检查 publicModels 必含 auto
  if (!config.publicModels.auto || config.publicModels.auto.kind !== "router") {
    throw new Error("publicModels must contain 'auto' with kind: 'router'");
  }

  // 检查 candidates 引用和非空
  for (const [pubId, pubConfig] of Object.entries(config.publicModels)) {
    if (pubConfig.kind === "alias") {
      if (pubConfig.candidates.length === 0) {
        throw new Error(`publicModels.${pubId} candidates cannot be empty`);
      }
      for (const candidate of pubConfig.candidates) {
        if (!modelIds.has(candidate)) {
          throw new Error(`Unknown candidate '${candidate}' in publicModels.${pubId}`);
        }
      }
    }
  }

  // 检查 tiers[].publicModel 引用
  for (const [tier, tierConfig] of Object.entries(config.routing.tiers)) {
    const pub = config.publicModels[tierConfig.publicModel];
    if (!pub || pub.kind !== "alias") {
      throw new Error(`Tier ${tier} references invalid publicModel: ${tierConfig.publicModel}`);
    }

    // 检查 fallback 引用
    if (tierConfig.fallback) {
      for (const fallbackId of tierConfig.fallback) {
        if (!config.publicModels[fallbackId]) {
          throw new Error(`Tier ${tier} fallback references unknown model: ${fallbackId}`);
        }
      }
    }
  }

  // 检查 proxy.port 范围
  if (!Number.isInteger(config.proxy.port) || config.proxy.port < 1 || config.proxy.port > 65535) {
    throw new Error(`proxy.port must be an integer between 1-65535, got: ${config.proxy.port}`);
  }

  // 检查 proxy.headers 值都是字符串
  if (config.proxy.headers) {
    for (const [key, value] of Object.entries(config.proxy.headers)) {
      if (typeof value !== "string") {
        throw new Error(`proxy.headers['${key}'] must be a string, got: ${typeof value}`);
      }
    }
  }
}
