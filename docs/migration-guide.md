# 迁移指南：v0.1.0 → v0.2.0

## 破坏性变更

1. **配置文件成为唯一启动入口**：CLI 必须提供 `--config`，OpenClaw 插件必
   须提供 `pluginConfig.config` 或 `pluginConfig.configPath`。不再支持无配
   置启动，也不再提供基于环境变量的 fallback。
2. **`models[].id` 现在就是实际上游模型 ID**：v0.2.0 配置格式不包含
   `upstreamModel` 字段。项目尚未上线旧 schema，因此不提供迁移检测、自
   动兼容层或回退逻辑。
3. **公开模型语义改为「固定 `auto` 请求入口 + 配置驱动内部 alias」**：
   `auto` 是唯一固定保留、也是唯一对外可请求的 model。`flash` / `pro`
   之类条目仍然来自 `config.publicModels`，但只作为内部路由 alias 使用。
4. **OpenClaw provider 暴露的模型列表收敛为 `auto`**：即使路由配置里仍
   有 `flash` / `pro` / `lite` / `think`，写入
   `models.providers.xiaoyiprovider.models` 时也只保留 `auto`。
5. **路由评分的公开可调参数只有两项**：`routing.tierBoundaries` 和
   `routing.confidenceThreshold` 是唯一开放的 scoring knobs。dimension
   weights、keyword lists、token thresholds、confidence steepness 仍然属
   于内部实现常量。
6. **错误响应统一为 OpenAI-compatible 结构**：响应体统一为
   `{ "error": { "message", "type", "code" } }` 这一类结构（当前实现还会
   带 `param: null`）。
7. **公开诊断头统一为 `x-xy-router-*`**：外部集成不应再依赖旧 header 命
   名。

## 迁移步骤

1. 以 `config.example.json` 为模板创建 v0.2.0 配置文件。
2. 把 `models[].id` 改成真实上游模型名，例如 `deepseek-v4-flash`、
   `deepseek-v4-pro`；删除任何 `upstreamModel` 字段。
3. 在 `publicModels` 中声明内部 alias，并在 `routing.tiers` 中引用这些
   alias。客户端 / OpenClaw 侧统一只请求 `auto`。
4. CLI、脚本和自动化命令统一改用 `llm-router --config config.json`。
5. OpenClaw 插件配置统一改到 `plugins.entries.llm-router`，并通过
   `models.providers.xiaoyiprovider` 观察 Router 注入的 provider 状态。
6. 如果你的旧客户端、脚本或测试显式请求 `flash` / `pro`，请全部改为
   `auto`，并通过 `x-xy-router-model` /
   `x-xy-router-actual-model` 读取最终 alias / physical model。
7. 如果需要调路由阈值，只修改 `routing.tierBoundaries` 和
   `routing.confidenceThreshold`；不要尝试在配置文件中注入其他 scoring
   internals。
