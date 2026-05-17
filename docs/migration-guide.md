# 迁移指南：v0.1.0 → v0.2.0

## 破坏性变更

1. **配置文件成为唯一启动入口**：CLI 必须提供 `--config`，OpenClaw
   插件必须提供 `pluginConfig.config` 或 `pluginConfig.configPath`。不再支
   持无配置启动，也不再提供旧的 env fallback。
2. **`models[].id` 现在就是实际上游模型 ID**：v0.2.0 配置格式不包含
   `upstreamModel` 字段。项目尚未上线旧 schema，因此不提供迁移检测、
   自动兼容层或回退逻辑。
3. **公开模型合同改为配置驱动**：`auto` 是唯一固定保留的 public model。
   除 `auto` 外，公开模型 ID 全部来自 `config.publicModels`。`flash` /
   `pro` 只是 `config.example.json` 中的示例 alias。
4. **旧 provider object API 已删除**：无配置启动、旧 provider object
   API、`createXiaoyiProvider` 和 `XIAOYI_OPENCLAW_MODELS` 均已移除。
   OpenClaw provider 模型目录现在由 `config.publicModels` 和 `config.models`
   生成。
5. **错误响应统一为 OpenAI-compatible 结构**：响应体统一为
   `{ "error": { "message", "type", "code" } }` 这一类结构（当前实现还会
   带 `param: null`）。

## 迁移步骤

1. 以 `config.example.json` 为模板创建 v0.2.0 配置文件。
2. 把 `models[].id` 改成真实上游模型名，例如 `deepseek-v4-flash`、
   `deepseek-v4-pro`；删除任何 `upstreamModel` 字段。
3. 在 `publicModels` 中声明对外公开的 alias，并在 `routing.tiers`
   中引用这些 alias。若沿用示例配置，客户端使用 `auto`、`flash`、`pro`
   即可。
4. CLI 用户改用 `xiaoyi-router --config config.json`；OpenClaw 插件用户设
   置 `pluginConfig.config` 或 `pluginConfig.configPath`。
5. 如果客户端依赖旧错误格式或固定 `deepseek-v4-*` public model 合同，
   需要同步改到 v0.2.0 的配置驱动语义。
