# LLM Router 设计说明

本文只描述 v0.2.0 当前实现，不保留旧版固定模型合同、环境变量启动或旧
provider API 的历史口径。

## 1. 产品边界

LLM Router 是一个本地 OpenAI-compatible Chat Completions 路由代理，也可
以作为 OpenClaw 插件加载。

当前版本只实现两件事：

- `GET /health`
- `POST /v1/chat/completions`

不会实现：

- `GET /v1/models`
- 通用多 provider 网关
- 配置缺失时的 fallback 启动
- 对外显式选择 `flash` / `pro` 等 alias 的请求协议

## 2. 配置驱动合同

v0.2.0 的模型语义完全来自配置文件，但要分清「外部入口」和「内部语义」：

- `publicModels.auto` 是唯一固定保留、也是唯一对外可请求的 model。
- 其余 `publicModels[*]` 都是 Router 内部 alias。
- `models[].id` 直接表示真实上游模型名。
- `routing.tiers.*` 只引用 alias，不引用 physical model。

配置校验由 `src/config-loader.ts` 负责，关键 fast-fail 规则包括：

- `publicModels.auto` 必须存在，且必须是 `kind: "router"`。
- router `metadata` 必须完整且字段类型正确。
- alias `candidates[]` 必须引用存在的 `models[].id`。
- `routing.tiers.*.publicModel` 和 `fallback[]` 只能引用 alias public model。
- OpenClaw 插件必须提供 `pluginConfig.config` 或 `pluginConfig.configPath`。

### 2.1 Routing thresholds

评分阈值属于内部算法常量，不开放配置。旧配置如果残留阈值字段，加载期不报错，运行时仍使用内置默认值。

下面这些参数不开放配置：

- tier boundaries
- confidence threshold
- dimension weights
- keyword lists
- token thresholds
- confidence steepness

这意味着：文档会解释它们的语义边界，但 `RawConfig` 不会为这些内部参数暴露覆
写口。

## 3. 运行链路

请求链路分成两层语义：

1. alias 级别的路由决策
2. physical model 级别的真实转发

典型流程：

```text
client
  -> POST /v1/chat/completions
  -> proxy.ts 校验请求 model 是否属于 requestable public models（当前仅 auto）
  -> route() 为 auto 请求返回 alias 决策
  -> resolvePublicModelCandidate() 将 alias 解析为 physical model
  -> 代理把上游请求体 model 改写为 physical model.id
  -> 转发到 upstream /chat/completions
  -> 返回原始响应体并追加路由响应头
```

职责边界很严格：

- `route()` 只决定 alias、tier、trace 等路由语义。
- `proxy.ts` 是唯一把 alias 解析成真实上游模型并发起请求的编排层。

## 4. OpenClaw 集成

插件加载逻辑位于 `src/plugin.ts`。

它负责：

- 从 `pluginConfig.config` 或 `pluginConfig.configPath` 加载 `RawConfig`
- 允许 `port` / `upstreamUrl` / `trace` 覆盖 `config.proxy.*`
- 根据 `publicModels` 与 `models` 生成 provider 元数据
- 写入或修复 `models.providers.xiaoyiprovider`
- 在运行态注册 `llm-router-proxy` 服务并管理代理生命周期
- 对 OpenClaw 只暴露 `auto` 这个稳定请求入口

它不会：

- 注册 provider
- 声明 providers manifest
- 读取环境变量作为配置来源
- 把内部 alias 直接暴露给 OpenClaw 选择

## 5. 响应头合同

代理会在上游响应基础上追加以下头：

| Header                     | 含义                                  |
| -------------------------- | ------------------------------------- |
| `x-xy-router-model`        | Router 内部最终暴露出来的 alias。     |
| `x-xy-router-actual-model` | 实际发往上游请求体的 physical model。 |
| `x-xy-router-tier`         | 本次请求最终 tier。                   |
| `x-xy-router-trace`        | 紧凑 trace 摘要。                     |
| `x-xy-router-routed`       | 是否经过 `auto` 路由。                |
| `x-xy-router-fallback`     | 当前实现固定为 `false`。              |
| `x-xy-router-upstream`     | 当前代理配置的上游 API base。         |

因此：

- `x-xy-router-model=flash` 表示 Router 内部语义层路由到了 `flash`
- `x-xy-router-actual-model=deepseek-v4-flash` 表示真实上游仍可能是
  `deepseek-v4-flash`

这两层语义允许内部 alias 与真实上游模型彻底解耦，同时保持客户端始终只请求
`auto`。

## 6. 验收关注点

本版本收尾时需要持续守住下面几条：

- 生产代码不再依赖旧固定模型常量或旧 schema 名字。
- 显式 alias 请求必须被 `400` 拒绝，并只提示 `Supported models: auto`。
- `auto` 路由返回 alias 头，不能把真实上游模型名泄漏为请求合同。
- OpenClaw provider 注入后只暴露 `auto`。
- 坏配置必须在加载期 fast-fail，而不是运行中兜底。
- 评分阈值不属于公开配置面，运行时固定使用内置默认值。

若需要了解迁移细节，请看 [migration-guide.md](./migration-guide.md)；若需要模
块级维护说明，请看 [development.md](./development.md)。
