# LLM Router 开发文档

本文说明 v0.2.0 当前实现的配置驱动架构、模块职责和维护约束。重点是统一下面
3 件事：

- HTTP / OpenClaw 请求边界固定只接受 `auto`。
- `route()` 只负责返回内部 alias 级别的路由决策。
- `proxy.ts` 是唯一把 alias 解析成 physical model 并发起上游请求的编排层。

## 1. 项目定位

`llm-router` 是一个面向 OpenAI-compatible Chat Completions API 的本地路由
代理，也可以作为 OpenClaw 插件加载。

v0.2.0 当前的模型语义是：

- `auto` 是唯一固定保留、也是唯一对外可请求的 model。
- 除 `auto` 外，`config.publicModels` 里的条目全部是内部 alias。
- `models[].id` 直接表示真实上游模型 ID。
- `flash` / `pro` 只是 `config.example.json` 里的示例 alias，不是固定公共请
  求协议。

当前版本只实现：

```text
GET  /health
POST /v1/chat/completions
```

`GET /v1/models` 未实现。

## 2. 配置驱动合同

核心配置结构定义在 `src/config-schema.ts`：

- `proxy`：本地代理端口、上游 API base、默认 header、trace。
- `models`：physical models；`id` 就是实际上游模型名。
- `publicModels`：Router 内部语义层；包括 `auto` router 和若干 alias。
- `routing`：tier 到 alias 的映射。

关键约束由 `src/config-loader.ts` 校验：

- `publicModels.auto` 必须存在，且必须是 `kind: "router"`。
- alias `candidates[]` 必须引用 `models[].id` 中存在的真实模型。
- `routing.tiers.*.publicModel` / `fallback[]` 只能引用 alias public model。

### 2.1 Routing thresholds

路由评分阈值属于内部实现常量，不属于公开配置合同。旧配置如果残留相关字段，
加载期不报错，运行时仍固定使用内置默认值。

以下参数不属于公开配置合同：

- tier boundaries
- confidence threshold
- dimension weights
- keyword lists
- token thresholds
- confidence steepness

这些实现常量保留在 `src/router/config.ts` 中，不提供 `RawConfig` 级别的覆写口。

因此，当前项目的稳定外部合同应理解为：

- **对外请求入口固定为 `auto`**。
- **内部路由 alias 由配置驱动**。
- **真实上游 physical model 也由配置驱动**。
- **评分阈值不属于公开配置面，运行时固定使用内置默认值**。

## 3. 请求链路

典型链路如下：

```text
客户端 / OpenClaw
  -> POST /v1/chat/completions
  -> proxy.ts 校验请求 model 是否属于 requestable public models（当前仅 auto）
  -> route() 为 auto 请求返回 alias 级别决策
  -> proxy.ts 将 alias 解析为 physical model
  -> proxy.ts 改写上游请求体 model
  -> 上游 /chat/completions
  -> proxy.ts 追加 x-xy-router-* 响应头
```

这里最重要的职责边界是：

### 3.1 `route()` 的职责

`route()` 只返回语义层决策，例如：

- 当前 tier 是什么。
- 当前 alias 应该是 `flash` 还是 `pro`。
- trace / profile / confidence 等诊断信息。

它不知道上游真实模型名，也不应该知道。

### 3.2 `proxy.ts` 的职责

`src/proxy.ts` 是唯一的编排层，负责：

- 读取和校验 HTTP 请求。
- 执行请求边界校验：当前只允许 `auto`。
- 执行运行时保护：限制请求体大小、请求体读取时间和上游请求等待时间。
- 在客户端断开时取消上游请求，避免旧请求继续占用连接或产生额外成本。
- 对 `auto` 请求执行路由决策。
- 调用 `resolvePublicModelCandidate()` 把 alias 解析为 physical model。
- 把发往上游请求体中的 `model` 改写成真实模型名。
- 管理 session pinning、上游请求、失败返回和响应头。

换句话说，`route()` 决定「语义层该走哪个 alias」，`proxy.ts` 决定「实际上游该
发哪个 physical model」。


### 3.3 运行时保护默认值

`src/proxy.ts` 集中维护以下内部默认值，它们会同时作用于 CLI 和 OpenClaw 插件启动路径：

| 常量 | 默认值 | 说明 |
| ---- | -----: | ---- |
| `DEFAULT_MAX_BODY_BYTES` | 10 MB | 单个请求体最多读取的 UTF-8 字节数。 |
| `DEFAULT_BODY_READ_TIMEOUT_MS` | 30 秒 | 客户端发送完整请求体的最长时间。 |
| `DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS` | 300 秒 | 本地代理等待上游 Chat Completions 响应的最长时间。 |

这些值目前不是公开配置 schema 的一部分。若要开放给用户配置，需要同步更新 `src/config-schema.ts`、`src/proxy-config-resolver.ts`、CLI / plugin 入口、示例配置和用户文档。

## 4. 关键模块职责

| 文件                           | 职责                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `src/config-schema.ts`         | 定义 v0.2.0 配置结构和 alias / physical model 类型。                  |
| `src/config-loader.ts`         | 加载并校验配置文件，确保 `publicModels` 和 `models` 引用关系正确。    |
| `src/config.ts`                | 生成运行时 `RouterConfig`，不直接依赖 `process.env`。                 |
| `src/proxy-config-resolver.ts` | 合并配置文件与 CLI / plugin 覆盖项。                                  |
| `src/public-model-resolver.ts` | 把 alias 解析到具体 physical model。                                  |
| `src/provider.ts`              | 根据 `publicModels` 与 `models` 生成 OpenClaw provider 元数据。       |
| `src/router/*`                 | 负责评分、tier 选择、trace 构建和 alias 级别决策。                    |
| `src/proxy.ts`                 | HTTP 编排层；负责请求边界校验、alias 解析、上游转发和响应头。         |
| `src/plugin.ts`                | OpenClaw 集成层；负责加载配置、修复 provider 配置、管理代理生命周期。 |
| `src/session.ts`               | 维护 `auto` 请求的 session pinning。                                  |
| `src/cli.ts`                   | 提供 `--config`、`--port`、`--api-key`、`--base-url` 等入口。         |

## 5. OpenClaw 集成

### 5.1 provider 注入

插件不会注册 provider，也不会声明 providers。当前策略是：

- 加载 `pluginConfig.config` 或 `pluginConfig.configPath`。
- 计算本地 provider `baseUrl`，例如 `http://127.0.0.1:8402/v1`。
- 调用 `generateOpenClawModels(runtimeConfig.publicModels, runtimeConfig.models)`
  生成完整的路由语义元数据。
- 写回 `models.providers.xiaoyiprovider` 时，再把 `models` 过滤为只暴露
  `auto`。

这样做的原因是：OpenClaw 始终只需要一个稳定入口 `auto`，具体落到哪个
alias / physical model 应由 Router 内部决定，而不是把 alias 暴露给
OpenClaw 去选。

### 5.2 已删除的旧公开口径

以下旧口径在 v0.2.0 中都应视为已删除：

- 公开请求 `flash` / `pro` 的协议
- 无配置启动
- 旧 provider helper / object API
- 基于环境变量的启动路径

如果文档、脚本或外部集成仍依赖这些口径，应改为：

- 配置文件中的 `publicModels` / `routing`
- `generateOpenClawModels()`
- `pluginConfig.config` / `pluginConfig.configPath`
- 请求 `auto`，再从响应头读取最终 alias / physical model

## 6. 响应头与错误格式

### 6.1 响应头

`proxy.ts` 会在上游响应基础上追加：

| Header                     | 含义                          |
| -------------------------- | ----------------------------- |
| `x-xy-router-model`        | Router 内部最终选中的 alias。 |
| `x-xy-router-actual-model` | physical / upstream model。   |
| `x-xy-router-tier`         | 最终 tier。                   |
| `x-xy-router-trace`        | 紧凑 trace。                  |
| `x-xy-router-routed`       | 是否经过 `auto` 路由。        |
| `x-xy-router-fallback`     | 当前实现固定为 `false`。      |
| `x-xy-router-upstream`     | 当前代理配置的上游 API base。 |

示例：

```text
x-xy-router-model: flash
x-xy-router-actual-model: deepseek-v4-flash
x-xy-router-tier: MEDIUM
```

这 3 个头应一起理解：

- `model=flash` 代表 Router 内部最终选择了 `flash`。
- `actual-model=deepseek-v4-flash` 代表真实上游模型。
- `tier=MEDIUM` 代表本次路由评分结果。

### 6.2 错误响应

错误响应统一为 OpenAI-compatible 结构：

```json
{
  "error": {
    "message": "Invalid JSON body",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
```

`model_not_found` 这类错误当前会返回：

```json
{
  "error": {
    "message": "Unknown model \"foo\". Supported models: auto",
    "type": "invalid_request_error",
    "param": null,
    "code": "model_not_found"
  }
}
```

## 7. 版本与产物

v0.2.0 相关版本示例：

- `package.json` 版本号：`0.2.0`
- `src/proxy.ts` 的 `VERSION`：`0.2.0`
- `/health` 返回的 `version`：`0.2.0`
- `npm pack` 产物示例：`llm-router-0.2.0.tgz`

OpenClaw 侧真正能请求哪些模型，不取决于静态常量，而取决于当前请求边界与运
行时注入逻辑。当前结果是固定只暴露 `auto`。

## 8. 本地开发与验证

安装依赖并构建：

```bash
npm install
npm run build
```

CLI 启动：

```bash
llm-router --config config.json
```

建议的最小验证集合：

```bash
npm test -- test/package-metadata.test.ts
npm run lint
npm run typecheck
```

手工验证时，至少检查：

1. `auto` 请求是否返回 alias 头和 actual model 头。
2. 显式 alias 请求是否被 `400` 拒绝，并提示 `Supported models: auto`。
3. OpenClaw `models.providers.xiaoyiprovider.models` 是否只包含 `auto`。

## 9. 维护提示

以后如果再调整模型相关能力，请优先检查是否破坏了下面这条边界：

```text
route() 负责 alias 决策
proxy.ts 负责 physical 解析和上游编排
```

如果未来要重新开放新的请求入口，至少需要同步修改：

- `src/proxy.ts` 里的请求边界校验
- `src/plugin.ts` 里的 provider 注入模型列表
- README、使用手册、开发文档中的对外合同描述
- `test/proxy.test.ts` 与 `test/plugin.test.ts` 中对应断言
