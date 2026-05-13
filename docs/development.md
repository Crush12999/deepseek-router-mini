# Xiaoyi Router 开发文档

本文面向后续维护者和贡献者，说明 `xiaoyi-router` 的项目定位、运行架构、OpenClaw 集成方式、路由规则、请求转发细节、开发流程和排查方法。文档基于当前源码、测试、插件清单、设计规格和实现计划整理，避免把未实现的设想写成现有能力。

## 1. 项目定位与设计目标

`xiaoyi-router` 是一个面向 OpenAI 兼容 Chat Completions API 的本地路由代理，也可以作为 OpenClaw 插件加载。它只暴露 3 个公共模型 ID：

| 模型 ID             | 含义                         | 是否直接转发到上游        |
| ------------------- | ---------------------------- | ------------------------- |
| `auto`              | 本地自动路由入口             | 否，会先选出 Flash 或 Pro |
| `deepseek-v4-flash` | 低成本、低延迟模型           | 是                        |
| `deepseek-v4-pro`   | 复杂推理、调试、长上下文模型 | 是                        |

核心目标如下：

- 为 OpenAI 兼容 Chat Completions 客户端提供一个很小的本地代理，只实现项目需要的接口。
- 让用户使用 `auto` 时，由本地规则把普通请求发给 Flash，把复杂请求发给 Pro。
- 在 OpenClaw 中以插件形式写入或修复 `models.providers.xiaoyiprovider`，把标准 OpenAI 兼容 provider 配置指向本地代理。
- 保留用户已有上游密钥和自定义 Header，不在插件中写入真实密钥。
- 避免引入钱包、x402、USDC、BlockRun、Solana、缓存等非目标能力。

当前版本不是通用 OpenAI 代理，也不是多 Provider 路由器。除 `GET /health` 和 `POST /v1/chat/completions` 外，其它路径都返回 404；`GET /v1/models` 明确未实现。

## 2. 架构总览

项目由 7 个主要部分组成：

- CLI：通过 `xiaoyi-router` 或 `node dist/cli.js` 启动本地代理。
- 本地代理：监听 `127.0.0.1:<port>`，处理健康检查和 Chat Completions 请求。
- OpenClaw 插件：默认导出插件对象，OpenClaw 启动时调用 `register(api)`。
- Provider 配置注入：写入或修复 `api.config.models.providers.xiaoyiprovider`，但不注册 provider。
- 路由器：根据 `auto` 请求的文本、工具、长度等因素选择 Flash 或 Pro。
- 会话钉住：同一会话一旦成功进入 Pro，后续 `auto` 请求继续走 Pro。
- 上游转发：把请求发往 OpenAI 兼容上游，默认是 `https://api.deepseek.com`。

典型 OpenClaw 请求流如下：

```text
OpenClaw Gateway
  -> xiaoyiprovider Provider 配置 baseUrl = http://127.0.0.1:8402/v1
  -> POST /v1/chat/completions
  -> xiaoyi-router 本地代理
  -> auto 路由、会话钉住
  -> POST https://api.deepseek.com/chat/completions
  -> 返回响应并追加 x-xiaoyi-router-* 响应头
```

需要特别区分两个 `baseUrl`。本地 Router API 和上游 API base 是两层概念，必须分离：

- OpenClaw Provider 的 `models.providers.xiaoyiprovider.baseUrl`：本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。OpenClaw 的 `openai-completions` 适配器会在该 `baseUrl` 后追加 `/chat/completions`，最终落到本插件暴露的 `POST /v1/chat/completions`。
- 插件运行时的上游 API base：实际转发到 OpenAI 兼容上游时使用，优先级是 `pluginConfig.upstreamUrl` > `XIAOYI_BASE_URL` > `https://api.deepseek.com`。

实际转发到上游时，绝不能使用 OpenClaw Provider 的 `baseUrl`。上游请求 URL 始终按 `trimTrailingSlash(upstreamBaseUrl) + /chat/completions` 生成。上游 `baseUrl` 是否带 `/v1`、`/v4` 或不带版本，由用户配置决定；项目不自动追加版本段、不猜 provider、不根据域名分支。`upstreamBaseUrl` 不应包含完整资源路径 `/chat/completions`。

示例：

| `upstreamBaseUrl`                | 实际上游请求 URL                                  |
| -------------------------------- | ------------------------------------------------- |
| `https://api.deepseek.com`       | `https://api.deepseek.com/chat/completions`       |
| `https://gateway.example.com/v1` | `https://gateway.example.com/v1/chat/completions` |
| `https://gateway.example.com/v4` | `https://gateway.example.com/v4/chat/completions` |

## 3. 目录结构与关键模块职责

```text
.
├── README.md
├── openclaw.plugin.json
├── package.json
├── src
│   ├── cli.ts
│   ├── config.ts
│   ├── index.ts
│   ├── models.ts
│   ├── plugin.ts
│   ├── provider.ts
│   ├── proxy.ts
│   ├── session.ts
│   └── router
│       ├── classifier.ts
│       ├── config.ts
│       ├── rules.ts
│       ├── selector.ts
│       ├── strategy.ts
│       ├── trace.ts
│       └── types.ts
└── test
    ├── cli.test.ts
    ├── config.test.ts
    ├── models.test.ts
    ├── package-entrypoint.test.ts
    ├── package-metadata.test.ts
    ├── plugin.test.ts
    ├── provider.test.ts
    ├── proxy.test.ts
    ├── router-audit.test.ts
    ├── router.test.ts
    ├── router-trace.test.ts
    └── session.test.ts
```

关键模块职责：

| 文件                     | 职责                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `src/config.ts`          | 解析代理配置，包含默认端口、默认上游、环境变量、额外 Header JSON。               |
| `src/models.ts`          | 定义唯一支持的 3 个模型 ID、模型元数据和模型 ID 校验。                           |
| `src/provider.ts`        | 定义 Xiaoyi provider 配置使用的模型价格、能力、上下文窗口等元数据。              |
| `src/plugin.ts`          | 实现 OpenClaw 插件注册、配置注入、服务生命周期和代理句柄管理。                   |
| `src/proxy.ts`           | 实现 HTTP 服务、请求解析、模型选择、Header 合并、上游转发和响应透传。             |
| `src/router/config.ts`   | 定义默认路由版本、评分维度、tier 边界、profile tier 和 override。                |
| `src/router/rules.ts`    | 实现多维规则评分、codebase debugging 识别和 agentic 评分。                       |
| `src/router/strategy.ts` | 实现 `RulesStrategy`，把评分结果映射为 tier、profile 和路由决策。                |
| `src/router/selector.ts` | 根据 tier 配置选择模型、计算成本，并暴露 tier helper。                            |
| `src/router/trace.ts`    | 生成紧凑 trace 摘要，按 `off` / `summary` / `debug` 输出路由诊断日志。           |
| `src/session.ts`         | 根据 `x-session-id` 或首条用户消息生成会话 ID，记录可复用的 Pro 会话状态。       |
| `src/cli.ts`             | 解析 CLI 参数，启动代理，处理 `SIGINT` / `SIGTERM`。                             |
| `src/index.ts`           | 导出公共 API，并默认导出 OpenClaw 插件对象。                                     |

测试文件与模块大体一一对应。`test/proxy.test.ts` 覆盖真实本地 HTTP 代理行为；`test/plugin.test.ts` 覆盖 OpenClaw 插件生命周期和配置注入；`test/package-entrypoint.test.ts` 会执行 `npm run build` 后从打包入口做冒烟验证。

## 4. 路由规则详解

### 4.1 模型入口

请求体中的 `model` 必须是 `auto`、`deepseek-v4-flash` 或 `deepseek-v4-pro`。不支持的值会返回 HTTP 400，响应体包含支持的模型列表。

显式模型的处理规则：

- `deepseek-v4-flash`：直接转发到上游 Flash，`x-xiaoyi-router-routed` 为 `false`。
- `deepseek-v4-pro`：直接转发到上游 Pro，`x-xiaoyi-router-routed` 为 `false`。
- `auto`：本地选择真实上游模型，`x-xiaoyi-router-routed` 为 `true`。

### 4.2 评分分层

当前 `auto` 请求走 `route()`，底层策略为 `RulesStrategy`。它不是旧版「simple / code / complex 直接映射」模型，而是先进行多维规则评分，再映射到 `SIMPLE`、`MEDIUM`、`COMPLEX` 或 `REASONING` tier。

评分输入包括：

- 用户路由文本。
- system prompt。
- 估算输入 token 数，按 `(systemPrompt + prompt).length / 4` 粗略估算。
- `max_tokens` 或 `max_completion_tokens`，缺省按 `1024` 估算。
- 请求是否包含工具。

主要评分维度包括输入长度、代码关键词、推理关键词、技术关键词、创意关键词、简单任务关键词、多步骤模式、问题数量、命令式动词、约束数量、输出格式、引用复杂度、否定约束、领域专有词和 agentic 任务特征。

### 4.3 `auto` 到 Flash / Pro 的选择

面向用户的语义是：简单摘要、短文本和常规轻量任务默认 Flash；复杂推理、长上下文、明确的代码库调试 / 修复任务默认 Pro。当前默认 tier 配置如下：

| Tier        | 主模型              | fallback          |
| ----------- | ------------------- | ----------------- |
| `SIMPLE`    | `deepseek-v4-flash` | 无                |
| `MEDIUM`    | `deepseek-v4-flash` | 无                |
| `COMPLEX`   | `deepseek-v4-pro`   | 无                |
| `REASONING` | `deepseek-v4-pro`   | 无                |

几个重要细节：

- 命中至少 2 个推理关键词时进入 `REASONING`，走 Pro。
- 明确的代码库调试、回归定位、测试失败修复链路进入 `COMPLEX`，走 Pro。
- 结构化输出不会直接强制 Pro，只会把低于 `MEDIUM` 的请求提升到 `MEDIUM`。
- 轻量 agentic 请求即使带工具，也可以保持 Flash；工具存在会影响 profile，但不是无条件 Pro 开关。
- 长上下文只作为评分与能力信号参与决策，不再用固定阈值直接强制 Pro。
- 置信度低于阈值时使用 `MEDIUM` 作为保守默认层。

`src/router/classifier.ts` 和 `src/router/selector.ts` 中的 helper 仍可单独测试；当前代理主链路使用 `route()`、`RulesStrategy` 和 tier 配置。

### 4.4 OpenClaw bootstrap 包装处理

OpenClaw CLI 场景中，真实用户意图可能被包装在较长的 bootstrap 文本里。代理在 `proxy.ts` 里做了两层处理：

- 从 OpenAI 消息数组里提取文本内容，支持字符串内容和 `[{ type: "text", text: "..." }]` 形式。
- 对用户消息使用方括号时间戳 / turn 格式提取最后一段真实用户输入，避免被前面的 BOOTSTRAP、工具说明、代理说明误导。

例如，下列包装消息会按最后一段「Summarize briefly...」路由，而不是被 `apply_patch` 或 `src/plugin.ts` 诱导升级：

```text
[BEGIN BOOTSTRAP.md]
Use apply_patch for src/plugin.ts when editing files.
[END BOOTSTRAP.md]

Follow the BOOTSTRAP.md instructions above now.

[Sun 2026-05-10 01:47 GMT+8] Summarize briefly: OpenClaw routes simple tasks.
```

测试中验证了这类请求会继续走 Flash。

### 4.5 会话复用

会话逻辑的核心原则是「复用成功的 Pro，不复用普通 Flash 决策」：

- 如果某个 `auto` 会话实际走 Pro 且请求成功，后续同一会话的 `auto` 请求继续走 Pro。
- 如果某个 `auto` 会话走 Flash，不会创建可复用 pin；后续请求继续重新路由。
- 显式 Flash / Pro 请求不改变 `x-xiaoyi-router-routed`，但代理仍会派生会话 ID 供内部流程使用。

会话 ID 来源：

1. 优先读取请求头 `x-session-id`。如果是数组，使用第一个非空值。
2. 没有有效 Header 时，对首条用户消息文本规范化空白后做 SHA-256，并截取前 8 个十六进制字符。
3. 没有 Header 且开场文本为空时，不生成会话 ID。

## 5. OpenClaw 集成机制

### 5.1 Manifest 和包入口

`openclaw.plugin.json` 是插件清单，当前内容包含：

- `id`: `xiaoyi-router`
- `name`: `Xiaoyi Router`
- `description`: `Xiaoyi local routing proxy for OpenClaw`
- `version`: `0.1.0`
- `main`: `./dist/index.js`
- `activation.onStartup`: `true`
- `configSchema.port`: 本地代理端口，默认 `8402`
- `configSchema.upstreamUrl`: 上游 OpenAI 兼容 API base，默认 `https://api.deepseek.com`

`package.json` 同时声明：

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"]
  },
  "files": ["dist", "README.md", "openclaw.plugin.json"]
}
```

这保证 npm 包发布后包含构建产物、README 和 OpenClaw 插件清单。

### 5.2 默认导出和注册入口

`src/index.ts` 默认导出插件对象：

```ts
const plugin = {
  id: "xiaoyi-router",
  name: "Xiaoyi Router",
  description: "Xiaoyi local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
```

同时它保留公共命名导出，例如 `startProxy`、`resolveConfig`、`selectModel`、`XIAOYI_OPENCLAW_MODELS` 等，便于测试和外部集成。

### 5.3 `registerService`

`registerOpenClawPlugin(api)` 默认会先注册运行时服务：

```ts
api.registerService({
  id: "xiaoyi-router-proxy",
  async start() {
    // 启动本地代理
  },
  async stop() {
    // 关闭本地代理
  },
});
```

服务的 `start()` 才真正调用 `startProxy()`。也就是说，插件 `register()` 是同步返回的，不会在注册阶段直接启动代理。这样可以配合 OpenClaw 的服务生命周期。

存在一些只用于发现或元数据读取的注册模式不会注册运行时服务：

- `discovery`
- `cli-metadata`
- `setup-only`
- `tool-discovery`

这些模式仍会注入配置，但不会启动代理服务。

### 5.4 provider 兼容策略

为兼容 OpenClaw v2026.4.11 和 v2026.3.24，插件不会调用 `api.registerProvider()` 注册 `xiaoyiprovider` provider，也不会在 `openclaw.plugin.json` 中声明 providers。`xy_channel` 是可选组件：安装时可以由 `xy_channel` 负责 provider 实现和注册；未安装时，router 仍可作为标准 OpenAI 兼容 provider 配置下的本地路由服务使用。

插件会写入或修复 `models.providers.xiaoyiprovider`，让 OpenClaw 或 provider 实现把请求转到本地代理。配置等价于：

```ts
createXiaoyiProvider("http://127.0.0.1:8402/v1");
```

Provider 的关键字段：

- `id`: `xiaoyiprovider`
- `name`: `Xiaoyi Provider`
- `aliases`: `["xiaoyi"]`
- `auth`: `[]`
- `models.api`: `openai-completions`
- `models.baseUrl`: 本地代理 `/v1` 地址
- `models.models`: 3 个 OpenClaw 模型定义

模型元数据：

| 模型 ID             | 名称              | 输入价格 | 输出价格 | Cache Read | Cache Write |  上下文 | 最大输出 |
| ------------------- | ----------------- | -------: | -------: | ---------: | ----------: | ------: | -------: |
| `auto`              | Xiaoyi Auto       |        0 |        0 |          0 |           0 | 1000000 |    64000 |
| `deepseek-v4-flash` | DeepSeek V4 Flash |     0.28 |     0.42 |       0.07 |        0.28 | 1000000 |    64000 |
| `deepseek-v4-pro`   | DeepSeek V4 Pro   |     0.56 |     1.68 |       0.14 |        0.56 | 1000000 |    64000 |

所有模型声明 `reasoning: true`、`input: ["text"]`，API 适配器为 `openai-completions`。

OpenClaw 对外可选模型由 `src/provider.ts` 中的 `XIAOYI_OPENCLAW_MODELS` 决定。当前它从 `XIAOYI_MODELS` 派生 3 个模型，因此 `openclaw.json` 中会出现 `auto`、`deepseek-v4-flash` 和 `deepseek-v4-pro`。如果希望 OpenClaw UI / agent 配置只暴露 `auto`，应只过滤 `XIAOYI_OPENCLAW_MODELS`：

```ts
export const XIAOYI_OPENCLAW_MODELS: OpenClawModelDefinition[] =
  XIAOYI_MODELS.filter((model) => model.id === "auto").map((model) => ({
    // 保持现有 OpenClaw 模型元数据映射逻辑。
  }));
```

不要为此修改 `src/models.ts` 中的 `SUPPORTED_MODEL_IDS` 或 `MODEL_ROLES`。代理内部仍需要知道 Flash / Pro，才能完成 `auto` 路由、显式模型校验和 session pin。

### 5.5 Config 透传

插件不会把真实密钥写入 manifest 或 auth profile。它只读取 OpenClaw 运行时配置，并在服务启动时把可用配置传给代理：

- `models.providers.xiaoyiprovider.apiKey`
- `models.providers.xiaoyiprovider.api_key`
- `models.providers.xiaoyiprovider.headers`
- `models.providers.xiaoyiprovider.request.headers`

`headers` 和 `request.headers` 只接受字符串值，非字符串 Header 会被忽略。`request.headers` 会覆盖同名的 `headers`。

真实 OpenClaw Gateway 场景下，优先把 Key 配到 `models.providers.xiaoyiprovider.apiKey`。源码目录里的 `.env` 只对独立代理或当前 shell 有效，默认 Gateway service 通常不会读取它。维护者做端到端验证时，不要把「仓库 `.env` 已配置」当成 OpenClaw 已配置。

## 6. 配置来源与优先级

项目有两层配置：代理运行配置和 OpenClaw 插件配置。

### 6.1 代理运行配置

`resolveConfig()` 的来源和优先级：

| 配置项           | 优先级                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `baseUrl`        | 函数入参 `baseUrl` > `XIAOYI_BASE_URL` > `https://api.deepseek.com` |
| `apiKey`         | 函数入参 `apiKey` > `XIAOYI_API_KEY`                                |
| `headers`        | `XIAOYI_ROUTER_HEADERS` 先合入，函数入参 `headers` 后覆盖           |
| `port`           | 函数入参 `port` > `XIAOYI_ROUTER_PORT` > `8402`                     |
| `defaultModel`   | 函数入参 `defaultModel` > `auto`                                    |
| `sessionPinning` | 函数入参 `sessionPinning` > `true`                                  |
| `traceMode`      | 函数入参 `traceMode` > `XIAOYI_ROUTER_TRACE` > `off`                |

这里的 `baseUrl` 是插件运行时上游 API base，不是 OpenClaw Provider 的本地 `baseUrl`。它只参与上游请求 URL 计算，规则是去掉末尾 `/` 后追加 `/chat/completions`。

`XIAOYI_ROUTER_HEADERS` 必须是 JSON 对象，并且每个值都必须是字符串：

```bash
export XIAOYI_ROUTER_HEADERS='{"X-Request-Source":"xiaoyi-router"}'
```

错误示例：

```bash
export XIAOYI_ROUTER_HEADERS='["bad"]'
export XIAOYI_ROUTER_HEADERS='{"X-Debug":true}'
```

这两种都会在解析时抛出错误。

`XIAOYI_ROUTER_TRACE` 支持：

| 值        | 行为                                                                 |
| --------- | -------------------------------------------------------------------- |
| `off`     | 默认值，不输出路由日志。                                             |
| `summary` | 每次请求输出一行简要路由日志。                                       |
| `debug`   | 输出结构化 JSON，包含尝试链路、会话动作、评分信息和 prompt preview。 |

`debug` 模式只输出首尾截断后的 prompt preview，不输出完整 prompt。

### 6.2 OpenClaw 插件配置

插件运行配置的优先级：

| 配置项        | 优先级                                                                          |
| ------------- | ------------------------------------------------------------------------------- |
| `port`        | `api.pluginConfig.port` > `XIAOYI_ROUTER_PORT` > `8402`                         |
| `upstreamUrl` | `api.pluginConfig.upstreamUrl` > `XIAOYI_BASE_URL` > `https://api.deepseek.com` |

无效端口会被忽略。例如 `pluginConfig.port = "nope"` 时，如果 `XIAOYI_ROUTER_PORT=9011`，最终端口是 `9011`。

`upstreamUrl` 是上游 API base。它可以是 `https://api.deepseek.com`、`https://gateway.example.com/v1` 或 `https://gateway.example.com/v4` 这类地址，插件不会为它自动补版本段。

### 6.3 OpenClaw Provider 配置注入

`injectXiaoyiModelsConfig(config, providerBaseUrl)` 会保证：

```json
{
  "models": {
    "providers": {
      "xiaoyiprovider": {
        "baseUrl": "http://127.0.0.1:8402/v1",
        "api": "openai-completions",
        "models": ["<完整 OpenClaw 模型定义>"]
      }
    }
  }
}
```

注入规则：

- 如果 `models` 或 `providers` 不存在，会创建对象。
- 如果 `xiaoyiprovider` 配置不存在，会创建配置，但不会伪造真实 `apiKey`。
- 如果 `xiaoyiprovider` 配置已存在，会保留已有 `apiKey`、`api_key`、`headers`、`request` 和未知字段；不存在 `apiKey` 时不会新增该字段。
- 始终修复插件管理的字段：`baseUrl`、`api`、`models`。
- 可重复执行，不会追加重复 Provider，也不会把模型列表变成重复列表。
- 这里的 `baseUrl` 始终指向本地代理的 `/v1`。OpenClaw 的 `openai-completions` 适配器会补上 `/chat/completions`，所以本地 HTTP 服务必须暴露 `POST /v1/chat/completions`。

## 7. 请求转发细节

### 7.1 支持的 HTTP 接口

```text
GET  /health
POST /v1/chat/completions
```

本地 HTTP 服务对 OpenClaw 和普通 HTTP 客户端暴露版本化接口：`POST /v1/chat/completions`。`GET /health` 保留用于健康检查；`GET /v1/models` 当前未实现。

健康检查响应包含：

```json
{
  "status": "ok",
  "baseUrl": "https://api.deepseek.com",
  "version": "0.1.0"
}
```

未实现的路径返回 404。例如：

```bash
curl -i http://127.0.0.1:8402/v1/models
```

### 7.2 上游 URL 计算

代理收到合法的本地请求后，只使用插件运行时上游 API base 计算转发地址，不能复用 OpenClaw Provider 的本地 `baseUrl`。

计算规则：

```text
trimTrailingSlash(upstreamBaseUrl) + /chat/completions
```

示例：

| `upstreamBaseUrl`                | 实际上游请求 URL                                  |
| -------------------------------- | ------------------------------------------------- |
| `https://api.deepseek.com`       | `https://api.deepseek.com/chat/completions`       |
| `https://gateway.example.com/v1` | `https://gateway.example.com/v1/chat/completions` |
| `https://gateway.example.com/v4` | `https://gateway.example.com/v4/chat/completions` |

### 7.3 请求体处理

代理会完整读取请求体并解析 JSON：

- JSON 解析失败：返回 HTTP 400，错误为 `Invalid JSON body`。
- 请求体不是 JSON 对象：返回 HTTP 400。
- `model` 不在支持列表：返回 HTTP 400。
- 合法请求：根据模型选择真实上游模型，并把请求体中的 `model` 改写为真实模型。

### 7.4 Header 合并

上游 Header 来源包括：

1. 客户端请求 Header。
2. 代理配置 Header，例如 `XIAOYI_ROUTER_HEADERS` 或 OpenClaw Provider 透传 Header。
3. 代理配置中的 `apiKey`。

合并规则：

- 跳过 hop-by-hop Header，例如 `connection`、`host`、`content-length`、`transfer-encoding` 等。
- Header 名按大小写不敏感方式去重。
- 配置 Header 覆盖客户端请求 Header。
- `apiKey` 可选：如果最终没有 `Authorization`，并且配置里有 `apiKey`，代理会补充 `Authorization: Bearer <apiKey>`；如果没有配置 `apiKey`，代理不会发送 `Authorization`。
- 如果请求或配置里已经有 `Authorization`，遵循当前实现的 Header 合并语义，不会再用 `apiKey` 覆盖。
- `x-uid` 可通过 provider `headers` 或 `request.headers` 透传。
- 如果最终没有 `Content-Type`，代理会补充 `content-type: application/json`。

OpenClaw 场景下，常见情况是 Gateway 已经根据 Provider 配置注入了 `Authorization`。如果 OpenClaw 没有注入，代理仍可使用 `XIAOYI_API_KEY` 或插件启动时透传的 `apiKey` 兜底。

### 7.5 响应头处理

代理会复制上游响应 Header，但会过滤：

- hop-by-hop Header
- 上游响应中已有的 `x-xiaoyi-router-*` Header
- 上游响应中已有的历史兼容 `x-deepseek-router-*` Header

然后追加下列路由 Header：

| Header                     | 含义                                                |
| -------------------------- | --------------------------------------------------- |
| `x-xiaoyi-router-model`    | 实际发往上游的模型，Flash 或 Pro。                  |
| `x-xiaoyi-router-tier`     | 实际路由 tier：`SIMPLE`、`MEDIUM`、`COMPLEX` 等。   |
| `x-xiaoyi-router-trace`    | 紧凑路由摘要，例如 `auto:medium:flash:first-pass`。 |
| `x-xiaoyi-router-routed`   | 是否经过 `auto` 路由。                              |
| `x-xiaoyi-router-fallback` | 是否发生备用模型切换；当前实现固定为 `false`。      |
| `x-xiaoyi-router-upstream` | 当前代理配置的真实上游 API base。                   |

### 7.6 失败处理

当前代理不会在模型之间自动 fallback：

- 首次目标模型是 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时，都只发起一次上游请求。
- 上游返回 `429`、`500`、`502`、`503`、`504` 时，代理直接透传该失败响应。
- 网络错误返回 `502`。
- `x-xiaoyi-router-fallback` 作为稳定响应头保留，但当前始终为 `false`。

### 7.7 流式响应

代理不解析、不缓存、不重组流式响应。只要上游返回 `Response.body`，代理就逐块写入 Node.js `ServerResponse`，最后 `end()`。

测试覆盖了 `text/event-stream` 响应，确认响应体中 `data: [DONE]` 会透传给客户端。

## 8. 本地开发流程

### 8.1 环境要求

项目要求 Node.js 20 或更高版本：

```bash
node --version
```

建议使用 npm 安装依赖：

```bash
npm install
```

### 8.2 构建

```bash
npm run build
```

构建工具是 `tsup`，输出目录是 `dist`。OpenClaw 插件入口和 npm 包入口都指向构建后的文件。

### 8.3 启动代理

使用默认上游和默认端口：

```bash
export XIAOYI_API_KEY="<your-upstream-api-key>"
npm run build
node dist/cli.js
```

指定端口：

```bash
node dist/cli.js --port 8402
```

指定上游：

```bash
XIAOYI_BASE_URL="https://api.deepseek.com" node dist/cli.js --port 8402
```

指定额外上游 Header：

```bash
export XIAOYI_ROUTER_HEADERS='{"X-Request-Source":"xiaoyi-router"}'
node dist/cli.js --port 8402
```

### 8.4 本地请求验证

健康检查：

```bash
curl -s http://127.0.0.1:8402/health
```

Chat Completions：

```bash
curl -s http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <your-upstream-api-key>' \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "Translate hello to Chinese." }
    ]
  }'
```

### 8.5 测试、类型检查、Lint 和格式化

运行全部测试：

```bash
npm test
```

运行指定测试：

```bash
npm test -- test/router.test.ts test/proxy.test.ts test/plugin.test.ts
```

类型检查：

```bash
npm run typecheck
```

Lint：

```bash
npm run lint
```

格式检查：

```bash
npm run format:check
```

格式化：

```bash
npm run format
```

## 9. 测试策略

### 9.1 单元测试

建议保持模块级测试的边界清晰：

- `test/models.test.ts`：验证支持模型列表、模型 ID 校验、真实上游模型识别和模型元数据。
- `test/router.test.ts`：验证评分路由、agentic profile、结构化输出、长上下文评分信号、fallback chain helper 和 selector helper 行为。
- `test/router-trace.test.ts`：验证 trace 摘要、`summary` / `debug` 日志和 prompt preview。
- `test/router-audit.test.ts`：验证典型任务集的 Flash / Pro 分布校准。
- `test/session.test.ts`：验证 Pro 复用、禁用 pinning、Header 和内容派生会话 ID。
- `test/config.test.ts`：验证默认值、环境变量、Header JSON、入参覆盖优先级和 trace mode 默认行为。
- `test/cli.test.ts`：验证参数解析、帮助输出、未知命令处理。
- `test/provider.test.ts`：验证 provider 配置使用的模型定义完整性。
- `test/plugin.test.ts`：验证配置注入、生命周期、服务关闭、注册失败回滚、启动失败日志。

### 9.2 集成测试

`test/proxy.test.ts` 会启动真实本地 HTTP 上游和真实本地代理，覆盖：

- `/health` 和 404 行为。
- 不支持模型返回 400。
- 显式模型转发。
- `auto` 路由到 Flash / Pro。
- OpenClaw bootstrap 包装文本处理。
- Header 合并和大小写去重。
- `Authorization` 与 `apiKey` 的优先级。
- 会话复用。
- Flash 请求失败时不自动切换到 Pro。
- 网络错误返回 502。
- 非法 JSON 返回 400。
- 流式响应透传。

这类测试不需要真实上游 key，因为它们使用本地假上游。

### 9.3 真实 OpenClaw 验证建议

真实 OpenClaw 验证应放在发布前或集成分支上执行。验证时只使用当前机器的默认 OpenClaw Gateway，不创建临时 OpenClaw profile，不额外启动第二个 Gateway，也不使用源码目录或 link 安装。这样可以更接近用户真实安装路径，并避免留下难排查的端口占用。

先清理旧插件占用。历史版本可能以 `deepseek-router-mini` 安装并监听 `8402`：

```bash
openclaw plugins list --json
lsof -nP -iTCP:8402 -sTCP:LISTEN || true
openclaw plugins uninstall deepseek-router-mini || true
openclaw gateway restart
```

然后从源码打包安装：

```bash
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install --dangerously-force-unsafe-install --force "./${PACKAGE_TGZ}"
openclaw gateway restart
```

`--dangerously-force-unsafe-install` 只允许用于当前源码刚构建出的本地包。不要用它安装来源不明的 tarball。

确认插件和 provider 配置：

```bash
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
curl -sS http://127.0.0.1:8402/health
```

`models.providers.xiaoyiprovider` 的关键字段应是：

```text
baseUrl: http://127.0.0.1:8402/v1
api: openai-completions
models: auto, deepseek-v4-flash, deepseek-v4-pro
```

`openclaw models list` 在不同 OpenClaw 版本中的展示可能不一致。开发验证时不要只看模型列表，应以 provider 配置、本地 `/health` 和真实请求结果为准。

配置真实上游 Key：

```bash
openclaw config set models.providers.xiaoyiprovider.apiKey "$XIAOYI_API_KEY"
openclaw gateway restart
```

如果要验证 `x-uid` 透传，使用 provider `request.headers`：

```bash
cat <<'JSON' | openclaw config patch --stdin
{
  "models": {
    "providers": {
      "xiaoyiprovider": {
        "request": {
          "headers": {
            "x-uid": "your-uid"
          }
        }
      }
    }
  }
}
JSON
openclaw gateway restart
```

先用直接代理请求证明上游可达和响应头正确：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      {
        "role": "user",
        "content": "Return only: ok"
      }
    ],
    "max_tokens": 128,
    "temperature": 0
  }' | sed -n '1,60p'
```

预期响应头包含：

```text
x-xiaoyi-router-model: deepseek-v4-flash
x-xiaoyi-router-routed: false
x-xiaoyi-router-fallback: false
x-xiaoyi-router-upstream: https://api.deepseek.com
```

再用 OpenClaw agent CLI 覆盖真实调用链：

```bash
tmpbase="$(mktemp -d /tmp/xiaoyi-openclaw-agent.XXXXXX)"
openclaw agents add xiaoyi-e2e-agent \
  --workspace "$tmpbase/workspace" \
  --agent-dir "$tmpbase/agent" \
  --model xiaoyiprovider/auto \
  --non-interactive \
  --json

openclaw agent \
  --agent xiaoyi-e2e-agent \
  --message "Return exactly: XIAOYI_E2E_OK" \
  --json \
  --timeout 180
```

预期 `status` 为 `ok`，响应文本包含 `XIAOYI_E2E_OK`，agent 元数据使用 `xiaoyiprovider/auto`。

`openclaw agent` 的文本或 JSON 输出通常只显示 OpenClaw 侧配置的 provider 和模型，不一定暴露本代理添加的响应头。当前插件的 Gateway 日志只覆盖配置修复、代理启动和端口占用等生命周期事件，不会逐次记录路由后的实际模型。要证明最终分别路由到 Flash 和 Pro，应同时用 `curl -i http://127.0.0.1:8402/v1/chat/completions` 检查 `x-xiaoyi-router-model`；如果上游或外层网关会记录请求体，也可以在上游侧确认实际转发的 `model` 字段。

如果要验证模型 ID 改名是否足够集中，可以启动 [scripts/deepseek_openai_proxy.py](/Users/ming/Documents/Code/2026/ai_repos/deepseek-router-mini/scripts/deepseek_openai_proxy.py) 作为临时上游。脚本接受 `LLM_DeepSeekV4_Think0` 和 `LLM_DeepSeekV4_Pro_Think0`，并分别转发到 `deepseek-v4-flash` 和 `deepseek-v4-pro`，每个请求都会打印别名模型和实际上游模型：

```bash
export XIAOYI_API_KEY="<your-upstream-api-key>"
python3 scripts/deepseek_openai_proxy.py --port 19081
```

验证时只临时修改 `src/models.ts` 的模型注册表，把 light / strong 改成上述两个别名模型，然后把插件上游指向 Python 中转：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.upstreamUrl "http://127.0.0.1:19081/v1"
openclaw gateway restart
```

这类模型改名只用于本地架构验证，不提交到 git；脚本和使用说明可以提交。验证结束后恢复 `src/models.ts` 和插件上游配置。

验证结束后清理临时 agent、临时目录和本地 tarball：

```bash
openclaw agents delete xiaoyi-e2e-agent --force --json
rm -rf "$tmpbase" /tmp/xiaoyi-openclaw-agent.*
rm -f "./${PACKAGE_TGZ}"
```

不要把真实 API Key 写进测试日志、文档、提交信息或截图。需要展示配置时使用占位符：

```json
{
  "models": {
    "providers": {
      "xiaoyiprovider": {
        "apiKey": "<your-upstream-api-key>"
      }
    }
  }
}
```

## 10. 发布与安装流程

发布前建议至少执行：

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

确认 `npm pack --dry-run` 输出包含：

- `dist`
- `README.md`
- `openclaw.plugin.json`
- `package.json` 中的 `openclaw.extensions`

生成本地包：

```bash
PACKAGE_TGZ="$(npm pack --silent)"
```

安装到 OpenClaw 默认 Gateway：

```bash
openclaw plugins install --dangerously-force-unsafe-install --force "./${PACKAGE_TGZ}"
```

重启并确认插件配置：

```bash
openclaw gateway restart
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
```

发布验证时不要使用源码目录安装或 link 安装作为最终结论。它们适合本地调试，但容易被旧版本、软链路径或已有 Gateway 进程污染。

如果端口冲突，优先确认是不是旧插件仍在监听：

```bash
openclaw plugins list --json
lsof -nP -iTCP:8402 -sTCP:LISTEN || true
openclaw plugins uninstall deepseek-router-mini || true
openclaw gateway restart
```

如果确实不能释放默认端口，再修改插件配置后重启：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.port 9011
openclaw gateway restart
```

插件会把 `models.providers.xiaoyiprovider.baseUrl` 修复为 `http://127.0.0.1:9011/v1`。生产环境默认上游仍是 `https://api.deepseek.com`；如需接入兼容网关，可通过 `XIAOYI_BASE_URL` 或插件 `upstreamUrl` 配置覆盖，但不要把完整资源路径 `/chat/completions` 写进去。

## 11. 常见问题与排查

### 11.1 `GET /v1/models` 返回 404

这是当前设计。项目只实现：

```text
GET  /health
POST /v1/chat/completions
```

OpenClaw 的模型列表应来自 provider 实现和 `models.providers.xiaoyiprovider` 配置，而不是本地代理的 `/v1/models`。

### 11.2 请求返回 `Unsupported model`

检查请求体中的 `model`。只支持：

```text
auto
deepseek-v4-flash
deepseek-v4-pro
```

不要直接传 `xiaoyiprovider/auto` 给代理。`xiaoyiprovider/auto` 是 OpenClaw UI / 配置层的 Provider + 模型表示，发到本地代理时模型 ID 应是 `auto`。

### 11.3 端口被占用

插件服务启动失败时会记录类似信息：

```text
Xiaoyi Router failed to start on port 8402: listen EADDRINUSE
```

处理方式：

```bash
export XIAOYI_ROUTER_PORT=9011
openclaw gateway restart
```

或在 OpenClaw 插件配置中设置 `port`。

### 11.4 鉴权失败

检查以下来源是否至少有一个提供了有效 key：

- 客户端请求 Header：`Authorization: Bearer <your-upstream-api-key>`
- OpenClaw Provider 配置：`models.providers.xiaoyiprovider.apiKey`
- OpenClaw Provider 配置：`models.providers.xiaoyiprovider.api_key`
- 代理环境变量：`XIAOYI_API_KEY`

默认 OpenClaw Gateway 通常不会读取当前源码目录下的 `.env`。真实 Gateway 验证优先检查 provider 配置：

```bash
openclaw config get models.providers.xiaoyiprovider.apiKey
openclaw config get models.providers.xiaoyiprovider
```

如果同时存在自定义 `Authorization` Header 和 `apiKey`，最终会使用自定义 Header。

### 11.5 自定义 Header 没生效

确认 Header 值是字符串：

```json
{
  "headers": {
    "X-Provider": "yes"
  },
  "request": {
    "headers": {
      "X-Request": "yes"
    }
  }
}
```

非字符串值会被忽略。`request.headers` 会覆盖同名 `headers`。

### 11.6 明明是简单任务却走 Pro

可能原因：

- 用户最后一段真实输入被评分为 `COMPLEX` 或 `REASONING`，例如包含 debug、failing tests、architecture、refactor、root cause、prove、derive 等强信号。
- 同一 `x-session-id` 之前已经成功复用或升级到 Pro。
- 长上下文、工具存在、结构化输出等信号与其他规则叠加后，把请求打到了 Pro 所在 tier。

可以查看响应头确认原因范围：

```bash
curl -i http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <your-upstream-api-key>' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Summarize briefly."}]}'
```

重点观察：

- `x-xiaoyi-router-model`
- `x-xiaoyi-router-tier`
- `x-xiaoyi-router-trace`
- `x-xiaoyi-router-routed`
- `x-xiaoyi-router-fallback`
- `x-xiaoyi-router-upstream`

需要更细粒度原因时，可以临时设置 `XIAOYI_ROUTER_TRACE=debug`，查看结构化日志中的 `profile`、`method`、`confidence`、`score`、`agenticScore`、`attempts` 和 `sessionAction`。当前响应头不会输出完整评分信号，避免把诊断细节和 prompt 内容放进 HTTP Header。

### 11.7 如何配置上游 `baseUrl` 的版本段

`XIAOYI_BASE_URL` 或 `pluginConfig.upstreamUrl` 表示插件运行时上游 API base。项目不会替你决定 `/v1`、`/v4` 这类版本段，也不会根据域名猜测上游 provider。

默认上游：

```bash
export XIAOYI_BASE_URL="https://api.deepseek.com"
```

如果你的兼容网关把 Chat Completions 放在 `/v1` 或 `/v4` 下，需要在上游 API base 中显式写出该版本段：

```bash
export XIAOYI_BASE_URL="https://gateway.example.com/v1"
export XIAOYI_BASE_URL="https://gateway.example.com/v4"
```

代理只会去掉末尾 `/`，再追加 `/chat/completions`。不要把完整资源路径 `/chat/completions` 写进 `XIAOYI_BASE_URL` 或 `pluginConfig.upstreamUrl`。

## 12. 后续演进

当前 README 和设计文档把响应缓存列为 Phase 2 候选，但 v0.1 没有实现缓存。后续可以考虑：

- 响应缓存：仅对非流式、确定性请求启用，并把 `model`、`messages`、`tools`、`temperature`、`max_tokens`、`baseUrl` 纳入缓存键；必须区分 Flash 和 Pro。
- 更多路由规则：把规则拆成可配置策略，增加更精确的多语言复杂度判断。
- 观测性：在响应头或日志中暴露路由原因、会话 pin 命中和上游耗时。
- OpenClaw 真实版本兼容矩阵：记录不同 OpenClaw 版本对 `registerService`、`registrationMode`、Provider 配置字段的行为差异。
- 配置校验与错误提示：对格式非法、协议不受支持或明显不可用的上游 API base 给出更清晰提示。
- 流式失败处理：如果上游流已经开始，中途失败无法安全切换模型；当前保持单模型单次请求语义。

维护这类能力时，应优先补测试：路由规则改动补 `test/router.test.ts`，代理行为改动补 `test/proxy.test.ts`，OpenClaw 生命周期改动补 `test/plugin.test.ts`。
