import type { PhysicalModel } from "./config-schema.js";

/**
 * 运行时模型注册表，提供 O(1) 模型查询 API
 */
export type ModelRegistry = {
  /** 根据 ID 获取物理模型，不存在返回 undefined */
  get(id: string): PhysicalModel | undefined;
  /** 检查模型 ID 是否存在 */
  has(id: string): boolean;
  /** 返回所有注册的物理模型 */
  all(): PhysicalModel[];
};

/**
 * 从物理模型列表创建运行时注册表
 * @param models 物理模型列表
 * @returns 模型注册表实例
 * @throws {Error} 如果存在重复的模型 ID
 */
export function createModelRegistry(models: PhysicalModel[]): ModelRegistry {
  const map = new Map<string, PhysicalModel>();

  for (const model of models) {
    if (map.has(model.id)) {
      throw new Error(`Duplicate model ID: ${model.id}`);
    }
    map.set(model.id, model);
  }

  return {
    get(id: string) {
      return map.get(id);
    },
    has(id: string) {
      return map.has(id);
    },
    all() {
      return Array.from(map.values());
    },
  };
}
