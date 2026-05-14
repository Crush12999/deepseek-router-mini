import type { PhysicalModel } from "./config-schema.js";

/**
 * 运行时模型注册表，提供 O(1) 模型查询 API
 *
 * 不变性保证：所有返回值均为内部数据的浅拷贝，外部修改不会污染注册表。
 */
export type ModelRegistry = {
  /**
   * 根据 ID 获取物理模型，不存在返回 undefined。
   * 返回的对象是副本，修改不会影响注册表内部状态。
   */
  get(id: string): PhysicalModel | undefined;
  /** 检查模型 ID 是否存在 */
  has(id: string): boolean;
  /**
   * 返回所有注册的物理模型。
   * 返回的数组及其元素均为副本，修改不会影响注册表内部状态。
   */
  all(): readonly PhysicalModel[];
};

/**
 * 从物理模型列表创建运行时注册表
 *
 * 注册表持有传入模型的浅拷贝，调用方后续修改原始数组或对象不会影响注册表。
 *
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
    // 存入浅拷贝，隔离外部对原对象的后续修改
    map.set(model.id, { ...model });
  }

  return {
    get(id: string) {
      const model = map.get(id);
      // 返回浅拷贝，防止外部修改污染内部状态
      return model ? { ...model } : undefined;
    },
    has(id: string) {
      return map.has(id);
    },
    all() {
      return Array.from(map.values(), (model) => ({ ...model }));
    },
  };
}
