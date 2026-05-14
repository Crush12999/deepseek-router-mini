# 迁移指南：v0.1.0 → v0.2.0

## 破坏性变更

1. **CLI 必须提供 --config**：不再支持环境变量
2. **公开模型 ID 变更**：`deepseek-v4-flash` → `flash`，`deepseek-v4-pro` → `pro`
3. **插件必须配置**：不再自动读取 env fallback

## 迁移步骤

1. 创建配置文件（参考 config.example.json）
2. 更新客户端代码：将 `model: "deepseek-v4-flash"` 改为 `model: "flash"`
3. CLI 用户：改用 `xiaoyi-router --config config.json`
4. 插件用户：设置 `pluginConfig.configPath`
