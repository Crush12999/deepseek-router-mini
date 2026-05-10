# DeepSeek Router Mini 开发文档

本文面向后续维护者和贡献者，说明 `deepseek-router-mini` 的项目定位、运行架构、OpenClaw 集成方式、路由规则、请求转发细节、开发流程和排查方法。文档基于当前源码、测试、插件清单、设计规格和实现计划整理，避免把未实现的设想写成现有能力。

## 1. 项目定位与设计目标

`deepseek-router-mini` 是一个面向 DeepSeek 兼容 Chat Completions API 的本地路由代理，也可以作为 OpenClaw 插件加载。它只暴露 3 个公共模型 ID：

| 模型 ID             | 含义                         | 是否直接转发到上游        |
| ------------------- | ---------------------------- | ------------------------- |
| `auto`              | 本地自动路由入口             | 否，会先选出 Flash 或 Pro |
| `deepseek-v4-flash` | 低成本、低延迟模型           | 是                        |
| `deepseek-v4-pro`   | 复杂推理、调试、长上下文模型 | 是                        |

核心目标如下：

- 为 OpenAI 兼容 Chat Completions 客户端提供一个很小的本地代理，只实现项目需要的接口。
- 让用户使用 `auto` 时，由本地规则把普通请求发给 Flash，把复杂请求发给 Pro。
- 在 OpenClaw 中以插件形式注册 DeepSeek Provider，并把 OpenClaw 的 DeepSeek Provider 配置指向本地代理。
- 保留用户已有 DeepSeek 密钥和自定义 Header，不在插件中写入真实密钥。
- 对显式 Flash 请求提供有限 fallback：当 Flash 上游返回可重试状态或网络错误时，改用 Pro 再试一次。
- 避免引入钱包、x402、USDC、BlockRun、Solana、缓存等非目标能力。

当前版本不是通用 OpenAI 代理，也不是多 Provider 路由器。除 `GET /health` 和 `POST /v1/chat/completions` 外，其它路径都返回 404；`GET /v1/models` 明确未实现。

## 2. 架构总览

项目由 7 个主要部分组成：

- CLI：通过 `deepseek-router-mini` 或 `node dist/cli.js` 启动本地代理。
- 本地代理：监听 `127.0.0.1:<port>`，处理健康检查和 Chat Completions 请求。
- OpenClaw 插件：默认导出插件对象，OpenClaw 启动时调用 `register(api)`。
- Provider 注入：注册 `deepseek` Provider，并修复 `api.config.models.providers.deepseek`。
- 路由器：根据 `auto` 请求的文本、工具、长度等因素选择 Flash 或 Pro。
- 会话钉住：同一会话一旦升级到 Pro，后续 `auto` 请求继续走 Pro。
- 上游转发：把请求发往 DeepSeek 兼容上游，默认是 `https://api.deepseek.com`。

典型 OpenClaw 请求流如下：

```text
OpenClaw Gateway
  -> deepseek Provider 配置 baseUrl = http://127.0.0.1:8402/v1
  -> POST /v1/chat/completions
  -> deepseek-router-mini 本地代理
  -> auto 路由、会话钉住、fallback
  -> POST https://api.deepseek.com/chat/completions
  -> 返回响应并追加 x-deepseek-router-* 响应头
```

需要特别区分两个 `baseUrl`。本地 Router API 和上游 API base 是两层概念，必须分离：

- OpenClaw Provider 的 `models.providers.deepseek.baseUrl`：本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。OpenClaw 的 `openai-completions` 适配器会在该 `baseUrl` 后追加 `/chat/completions`，最终落到本插件暴露的 `POST /v1/chat/completions`。
- 插件运行时的上游 API base：实际转发到 DeepSeek 兼容上游时使用，优先级是 `pluginConfig.upstreamUrl` > `DEEPSEEK_BASE_URL` > `https://api.deepseek.com`。

实际转发到上游时，绝不能使用 OpenClaw Provider 的 `baseUrl`。上游请求 URL 始终按 `trimTrailingSlash(upstreamBaseUrl) + /chat/completions` 生成。上游 `baseUrl` 是否带 `/v1`、`/v4` 或不带版本，由用户配置决定；项目不自动追加版本段、不猜 provider、不根据域名分支。

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
│       ├── rules.ts
│       ├── selector.ts
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
    ├── router.test.ts
    └── session.test.ts
```

关键模块职责：

| 文件                       | 职责                                                                             |
| -------------------------- | -------------------------------------------------------------------------------- |
| `src/config.ts`            | 解析代理配置，包含默认端口、默认上游、环境变量、额外 Header JSON。               |
| `src/models.ts`            | 定义唯一支持的 3 个模型 ID、模型元数据和模型 ID 校验。                           |
| `src/provider.ts`          | 定义 OpenClaw DeepSeek Provider、模型价格、能力、上下文窗口等元数据。            |
| `src/plugin.ts`            | 实现 OpenClaw 插件注册、Provider 注册、配置注入、服务生命周期和代理句柄管理。    |
| `src/proxy.ts`             | 实现 HTTP 服务、请求解析、模型选择、Header 合并、上游转发、fallback 和响应透传。 |
| `src/router/classifier.ts` | 用正则规则把文本分为 `simple`、`standard`、`code`、`complex`。                   |
| `src/router/rules.ts`      | 维护简单、代码、复杂、长上下文规则常量。                                         |
| `src/router/selector.ts`   | 把分类、工具和上下文长度映射到 Flash 或 Pro。                                    |
| `src/session.ts`           | 根据 `x-session-id` 或开场文本生成会话 ID，并只钉住 Pro。                        |
| `src/cli.ts`               | 解析 CLI 参数，启动代理，处理 `SIGINT` / `SIGTERM`。                             |
| `src/index.ts`             | 导出公共 API，并默认导出 OpenClaw 插件对象。                                     |

测试文件与模块大体一一对应。`test/proxy.test.ts` 覆盖真实本地 HTTP 代理行为；`test/plugin.test.ts` 覆盖 OpenClaw 插件生命周期和配置注入；`test/package-entrypoint.test.ts` 会执行 `npm run build` 后从打包入口做冒烟验证。

## 4. 路由规则详解

### 4.1 模型入口

请求体中的 `model` 必须是 `auto`、`deepseek-v4-flash` 或 `deepseek-v4-pro`。不支持的值会返回 HTTP 400，响应体包含支持的模型列表。

显式模型的处理规则：

- `deepseek-v4-flash`：直接转发到上游 Flash，`x-deepseek-router-routed` 为 `false`。
- `deepseek-v4-pro`：直接转发到上游 Pro，`x-deepseek-router-routed` 为 `false`。
- `auto`：本地选择真实上游模型，`x-deepseek-router-routed` 为 `true`。

### 4.2 分类优先级

当前分类器按以下顺序匹配：

1. 复杂任务：调试、测试失败、架构、重构、多文件、root cause 等。
2. 代码任务：TypeScript、JavaScript、函数、类、文件名、实现、编辑文件、`apply_patch` 等。
3. 简单任务：翻译、总结、格式化、简短解释等。
4. 标准任务：没有命中上述规则的普通请求。

复杂任务优先级高于代码任务和简单任务。例如，同时包含「debug」和「TypeScript」时，会被归类为 `complex`。

### 4.3 `auto` 到 Flash / Pro 的选择

`selectModel()` 的决策规则如下：

| 条件                                | 目标模型            | 原因                           |
| ----------------------------------- | ------------------- | ------------------------------ |
| 估算输入字符数大于或等于 `120000`   | `deepseek-v4-pro`   | `long-context`                 |
| 分类结果为 `complex`                | `deepseek-v4-pro`   | `complex`                      |
| 请求包含工具，并且分类结果为 `code` | `deepseek-v4-pro`   | `tools`                        |
| 其它情况                            | `deepseek-v4-flash` | `simple` / `standard` / `code` |

几个重要细节：

- 普通代码生成默认走 Flash；只有「代码任务 + 实际有工具」才走 Pro。
- 简单请求即使带有环境工具，也不会因为 `tools` 数组存在而自动升级到 Pro。
- 当前 `selector.ts` 分类时只把用户路由文本传给 `classifyPrompt()`；`systemPrompt` 只参与输入长度估算，不参与复杂度分类。
- 长上下文阈值使用字符数粗略估算，不做 tokenizer 级别计算。

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

### 4.5 会话钉住

`SessionPinStore` 只钉住 Pro，不钉住 Flash：

- 如果某个 `auto` 会话被路由到 Pro，后续同一会话的 `auto` 请求继续走 Pro。
- 如果某个 `auto` 会话只走 Flash，不会写入 pin。
- 显式 Flash / Pro 请求不改变 `x-deepseek-router-routed`，但代理仍会派生会话 ID 供内部流程使用。

会话 ID 来源：

1. 优先读取请求头 `x-session-id`。如果是数组，使用第一个非空值。
2. 没有有效 Header 时，对开场文本的前 4096 个字符做 SHA-256，并截取 24 个十六进制字符，生成 `content:<hash>`。
3. 没有 Header 且开场文本为空时，不生成会话 ID。

## 5. OpenClaw 集成机制

### 5.1 Manifest 和包入口

`openclaw.plugin.json` 是插件清单，当前内容包含：

- `id`: `deepseek-router-mini`
- `name`: `DeepSeek Router Mini`
- `description`: `DeepSeek-only local routing proxy for OpenClaw`
- `version`: `0.1.0`
- `main`: `./dist/index.js`
- `activation.onStartup`: `true`
- `configSchema.port`: 本地代理端口，默认 `8402`
- `configSchema.upstreamUrl`: 上游 DeepSeek 兼容地址，默认 `https://api.deepseek.com`

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
  id: "deepseek-router-mini",
  name: "DeepSeek Router Mini",
  description: "DeepSeek-only local routing proxy for OpenClaw",
  version: VERSION,
  register: registerOpenClawPlugin,
};

export default plugin;
```

同时它保留公共命名导出，例如 `startProxy`、`resolveConfig`、`selectModel`、`DEEPSEEK_OPENCLAW_MODELS` 等，便于测试和外部集成。

### 5.3 `registerService`

`registerOpenClawPlugin(api)` 默认会先注册运行时服务：

```ts
api.registerService({
  id: "deepseek-router-proxy",
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

这些模式仍会注册 Provider 并注入配置，但不会启动代理服务。

### 5.4 `registerProvider`

插件会注册一个 DeepSeek Provider：

```ts
createDeepSeekProvider("http://127.0.0.1:8402/v1");
```

Provider 的关键字段：

- `id`: `deepseek`
- `name`: `DeepSeek`
- `aliases`: `["ds"]`
- `auth`: `[]`
- `models.api`: `openai-completions`
- `models.baseUrl`: 本地代理 `/v1` 地址
- `models.models`: 3 个 OpenClaw 模型定义

模型元数据：

| 模型 ID             | 名称              | 输入价格 | 输出价格 | Cache Read | Cache Write |  上下文 | 最大输出 |
| ------------------- | ----------------- | -------: | -------: | ---------: | ----------: | ------: | -------: |
| `auto`              | DeepSeek Auto     |        0 |        0 |          0 |           0 | 1000000 |    64000 |
| `deepseek-v4-flash` | DeepSeek V4 Flash |     0.28 |     0.42 |       0.07 |        0.28 | 1000000 |    64000 |
| `deepseek-v4-pro`   | DeepSeek V4 Pro   |     0.56 |     1.68 |       0.14 |        0.56 | 1000000 |    64000 |

所有模型声明 `reasoning: true`、`input: ["text"]`，API 适配器为 `openai-completions`。

### 5.5 重复 DeepSeek Provider 处理

OpenClaw 或其它插件可能已经注册了 `deepseek` Provider。当前实现只特殊处理错误信息匹配：

```text
provider already registered: deepseek
```

当捕获到这类错误时，插件会：

- 保留已经注册的运行时服务。
- 继续注入或修复 `api.config.models.providers.deepseek`。
- 记录日志：`DeepSeek provider already registered; keeping router service active`。
- 不再抛出异常。

如果 `registerProvider()` 抛出其它错误，插件会尝试 `unregisterService("deepseek-router-proxy")`，然后重新抛出错误，避免留下半注册状态。

### 5.6 Config 透传

插件不会把真实密钥写入 manifest 或 auth profile。它只读取 OpenClaw 运行时配置，并在服务启动时把可用配置传给代理：

- `models.providers.deepseek.apiKey`
- `models.providers.deepseek.api_key`
- `models.providers.deepseek.headers`
- `models.providers.deepseek.request.headers`

`headers` 和 `request.headers` 只接受字符串值，非字符串 Header 会被忽略。`request.headers` 会覆盖同名的 `headers`。

## 6. 配置来源与优先级

项目有两层配置：代理运行配置和 OpenClaw 插件配置。

### 6.1 代理运行配置

`resolveConfig()` 的来源和优先级：

| 配置项           | 优先级                                                                |
| ---------------- | --------------------------------------------------------------------- |
| `baseUrl`        | 函数入参 `baseUrl` > `DEEPSEEK_BASE_URL` > `https://api.deepseek.com` |
| `apiKey`         | 函数入参 `apiKey` > `DEEPSEEK_API_KEY`                                |
| `headers`        | `DEEPSEEK_ROUTER_HEADERS` 先合入，函数入参 `headers` 后覆盖           |
| `port`           | 函数入参 `port` > `DEEPSEEK_ROUTER_PORT` > `8402`                     |
| `defaultModel`   | 函数入参 `defaultModel` > `auto`                                      |
| `sessionPinning` | 函数入参 `sessionPinning` > `true`                                    |

这里的 `baseUrl` 是插件运行时上游 API base，不是 OpenClaw Provider 的本地 `baseUrl`。它只参与上游请求 URL 计算，规则是去掉末尾 `/` 后追加 `/chat/completions`。

`DEEPSEEK_ROUTER_HEADERS` 必须是 JSON 对象，并且每个值都必须是字符串：

```bash
export DEEPSEEK_ROUTER_HEADERS='{"X-Request-Source":"deepseek-router-mini"}'
```

错误示例：

```bash
export DEEPSEEK_ROUTER_HEADERS='["bad"]'
export DEEPSEEK_ROUTER_HEADERS='{"X-Debug":true}'
```

这两种都会在解析时抛出错误。

### 6.2 OpenClaw 插件配置

插件运行配置的优先级：

| 配置项        | 优先级                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| `port`        | `api.pluginConfig.port` > `DEEPSEEK_ROUTER_PORT` > `8402`                         |
| `upstreamUrl` | `api.pluginConfig.upstreamUrl` > `DEEPSEEK_BASE_URL` > `https://api.deepseek.com` |

无效端口会被忽略。例如 `pluginConfig.port = "nope"` 时，如果 `DEEPSEEK_ROUTER_PORT=9011`，最终端口是 `9011`。

`upstreamUrl` 是上游 API base。它可以是 `https://api.deepseek.com`、`https://gateway.example.com/v1` 或 `https://gateway.example.com/v4` 这类地址，插件不会为它自动补版本段。

### 6.3 OpenClaw Provider 配置注入

`injectDeepSeekModelsConfig(config, providerBaseUrl)` 会保证：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "baseUrl": "http://127.0.0.1:8402/v1",
        "api": "openai-completions",
        "apiKey": "<保留原值或 undefined>",
        "models": ["<完整 OpenClaw 模型定义>"]
      }
    }
  }
}
```

注入规则：

- 如果 `models` 或 `providers` 不存在，会创建对象。
- 如果 `deepseek` Provider 不存在，会创建配置，但不会伪造真实 `apiKey`。
- 如果 `deepseek` Provider 已存在，会保留已有 `apiKey`、`headers`、未知字段等。
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
2. 代理配置 Header，例如 `DEEPSEEK_ROUTER_HEADERS` 或 OpenClaw Provider 透传 Header。
3. 代理配置中的 `apiKey`。

合并规则：

- 跳过 hop-by-hop Header，例如 `connection`、`host`、`content-length`、`transfer-encoding` 等。
- Header 名按大小写不敏感方式去重。
- 配置 Header 覆盖客户端请求 Header。
- 如果最终没有 `Authorization`，并且配置里有 `apiKey`，代理会补充 `Authorization: Bearer <apiKey>`。
- 如果已经有 `Authorization`，不会再用 `apiKey` 覆盖。
- 如果最终没有 `Content-Type`，代理会补充 `content-type: application/json`。

OpenClaw 场景下，常见情况是 Gateway 已经根据 Provider 配置注入了 `Authorization`。如果 OpenClaw 没有注入，代理仍可使用 `DEEPSEEK_API_KEY` 或插件启动时透传的 `apiKey` 兜底。

### 7.5 响应头处理

代理会复制上游响应 Header，但会过滤：

- hop-by-hop Header
- 上游响应中已有的 `x-deepseek-router-*` Header

然后追加 3 个路由 Header：

| Header                       | 含义                               |
| ---------------------------- | ---------------------------------- |
| `x-deepseek-router-model`    | 实际发往上游的模型，Flash 或 Pro。 |
| `x-deepseek-router-routed`   | 是否经过 `auto` 路由。             |
| `x-deepseek-router-fallback` | 是否从 Flash fallback 到 Pro。     |

### 7.6 Fallback

可重试状态码：

```text
429, 500, 502, 503, 504
```

fallback 规则：

- 如果首次目标模型是 `deepseek-v4-flash`，且上游返回可重试状态，代理会丢弃响应体，再用 `deepseek-v4-pro` 重试。
- 如果首次目标模型是 `deepseek-v4-flash`，且发生网络错误，也会用 Pro 重试。
- 如果首次目标模型已经是 `deepseek-v4-pro`，不会降级，也不会再试 Flash。
- 对 `auto` 请求，如果 fallback 后实际走 Pro，会把该会话钉住到 Pro。

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
export DEEPSEEK_API_KEY="<your-deepseek-api-key>"
npm run build
node dist/cli.js
```

指定端口：

```bash
node dist/cli.js --port 8402
```

指定上游：

```bash
DEEPSEEK_BASE_URL="https://api.deepseek.com" node dist/cli.js --port 8402
```

指定额外上游 Header：

```bash
export DEEPSEEK_ROUTER_HEADERS='{"X-Request-Source":"deepseek-router-mini"}'
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
  -H 'authorization: Bearer <your-deepseek-api-key>' \
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
- `test/router.test.ts`：验证分类优先级、工具触发、长上下文、简单任务不被环境工具误伤。
- `test/session.test.ts`：验证 Pro-only pinning、禁用 pinning、Header 和内容派生会话 ID。
- `test/config.test.ts`：验证默认值、环境变量、Header JSON、入参覆盖优先级。
- `test/cli.test.ts`：验证参数解析、帮助输出、未知命令处理。
- `test/provider.test.ts`：验证 OpenClaw Provider 和模型定义完整性。
- `test/plugin.test.ts`：验证配置注入、生命周期、服务关闭、重复 Provider、注册失败回滚、启动失败日志。

### 9.2 集成测试

`test/proxy.test.ts` 会启动真实本地 HTTP 上游和真实本地代理，覆盖：

- `/health` 和 404 行为。
- 不支持模型返回 400。
- 显式模型转发。
- `auto` 路由到 Flash / Pro。
- OpenClaw bootstrap 包装文本处理。
- Header 合并和大小写去重。
- `Authorization` 与 `apiKey` 的优先级。
- 会话钉住。
- Flash 到 Pro 的 fallback。
- 网络错误返回 502。
- 非法 JSON 返回 400。
- 流式响应透传。

这类测试不需要真实 DeepSeek key，因为它们使用本地假上游。

### 9.3 真实 OpenClaw 验证建议

真实 OpenClaw 验证应放在发布前或集成分支上执行：

```bash
npm install
npm run build
npm pack
```

然后在 OpenClaw 环境安装打包文件：

```bash
openclaw plugins install ./deepseek-router-mini-0.1.0.tgz --force
```

如果 OpenClaw 安全扫描拦截安装，并且你确认正在安装本仓库刚构建的本地包，可以临时加上：

```bash
openclaw plugins install ./deepseek-router-mini-0.1.0.tgz --force --dangerously-force-unsafe-install
```

刷新插件 registry 并重启 Gateway：

```bash
openclaw plugins registry --refresh
openclaw gateway restart
```

确认插件、Provider 和模型：

```bash
openclaw plugins list --json
openclaw plugins inspect deepseek-router-mini --json
openclaw models list
```

验证重点：

- `openclaw models list` 能看到或可配置到 `deepseek/auto`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`。
- `deepseek/auto` 的请求被发送到 `http://127.0.0.1:<port>/v1`。
- 配置了真实 DeepSeek key 后请求成功。
- 未配置真实 key 时，模型可以显示，请求失败信息应清晰。
- 卸载或关闭插件时代理服务能停止。

建议再用 `openclaw agents` 和 `openclaw agent` 覆盖真实 CLI 用例：

```bash
openclaw agents add deepseek-router-dev \
  --workspace /tmp/openclaw-deepseek-router-workspace \
  --agent-dir /tmp/openclaw-deepseek-router-agent \
  --model deepseek/auto \
  --non-interactive

openclaw agent \
  --agent deepseek-router-dev \
  --message "Translate hello to Chinese."

openclaw agent \
  --agent deepseek-router-dev \
  --message "Debug a failing test across multiple files and explain the likely root cause."
```

`openclaw agent` 的文本或 JSON 输出通常只显示 OpenClaw 侧配置的 `deepseek/auto`，不一定暴露本代理添加的响应头。要证明最终分别路由到 Flash 和 Pro，应同时用 `curl -i http://127.0.0.1:<port>/v1/chat/completions` 检查 `x-deepseek-router-model`，或在上游 / Gateway 日志中确认实际转发请求体里的 `model` 字段。

不要把真实 API key 写进测试日志、文档、提交信息或截图。需要展示配置时使用占位符：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "apiKey": "<your-deepseek-api-key>"
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
npm pack
```

安装到 OpenClaw：

```bash
openclaw plugins install ./deepseek-router-mini-0.1.0.tgz --force
```

刷新并重启：

```bash
openclaw plugins registry --refresh
openclaw gateway restart
```

如果端口冲突，修改插件配置或环境变量后重启：

```bash
export DEEPSEEK_ROUTER_PORT=9011
openclaw gateway restart
```

如果需要临时指定上游：

```bash
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
openclaw gateway restart
```

## 11. 常见问题与排查

### 11.1 `GET /v1/models` 返回 404

这是当前设计。项目只实现：

```text
GET  /health
POST /v1/chat/completions
```

OpenClaw 的模型列表应来自 Provider 注册和配置注入，而不是本地代理的 `/v1/models`。

### 11.2 请求返回 `Unsupported model`

检查请求体中的 `model`。只支持：

```text
auto
deepseek-v4-flash
deepseek-v4-pro
```

不要直接传 `deepseek/auto` 给代理。`deepseek/auto` 是 OpenClaw UI / 配置层的 Provider + 模型表示，发到本地代理时模型 ID 应是 `auto`。

### 11.3 端口被占用

插件服务启动失败时会记录类似信息：

```text
DeepSeek Router Mini failed to start on port 8402: listen EADDRINUSE
```

处理方式：

```bash
export DEEPSEEK_ROUTER_PORT=9011
openclaw gateway restart
```

或在 OpenClaw 插件配置中设置 `port`。

### 11.4 鉴权失败

检查以下来源是否至少有一个提供了有效 key：

- 客户端请求 Header：`Authorization: Bearer <your-deepseek-api-key>`
- 代理环境变量：`DEEPSEEK_API_KEY`
- OpenClaw Provider 配置：`models.providers.deepseek.apiKey`
- OpenClaw Provider 配置：`models.providers.deepseek.api_key`

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

- 请求超过 `120000` 字符，触发长上下文规则。
- 用户最后一段真实输入命中了复杂任务正则，例如包含 debug、failing tests、architecture、refactor、root cause 等。
- 同一 `x-session-id` 之前已经被钉住到 Pro。
- Flash 首次请求返回可重试状态，触发 fallback 到 Pro。

可以查看响应头确认原因范围：

```bash
curl -i http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <your-deepseek-api-key>' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Summarize briefly."}]}'
```

重点观察：

- `x-deepseek-router-model`
- `x-deepseek-router-routed`
- `x-deepseek-router-fallback`

当前响应头不会直接暴露 `selectModel()` 的 `reason` 字段。如需线上排查更细粒度原因，需要后续增加观测性能力。

### 11.7 如何配置上游 `baseUrl` 的版本段

`DEEPSEEK_BASE_URL` 或 `pluginConfig.upstreamUrl` 表示插件运行时上游 API base。项目不会替你决定 `/v1`、`/v4` 这类版本段，也不会根据域名猜测上游 provider。

默认 DeepSeek 上游：

```bash
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
```

如果你的兼容网关把 Chat Completions 放在 `/v1` 或 `/v4` 下，需要在上游 API base 中显式写出该版本段：

```bash
export DEEPSEEK_BASE_URL="https://gateway.example.com/v1"
export DEEPSEEK_BASE_URL="https://gateway.example.com/v4"
```

代理只会去掉末尾 `/`，再追加 `/chat/completions`。

## 12. 后续演进

当前 README 和设计文档把响应缓存列为 Phase 2 候选，但 v0.1 没有实现缓存。后续可以考虑：

- 响应缓存：仅对非流式、确定性请求启用，并把 `model`、`messages`、`tools`、`temperature`、`max_tokens`、`baseUrl` 纳入缓存键；必须区分 Flash 和 Pro。
- 更多路由规则：把规则拆成可配置策略，增加更精确的多语言复杂度判断。
- 观测性：在响应头或日志中暴露路由原因、会话 pin 命中、fallback 原因、上游耗时。
- OpenClaw 真实版本兼容矩阵：记录不同 OpenClaw 版本对 `registerService`、`registrationMode`、Provider 配置字段的行为差异。
- 配置校验与错误提示：对格式非法、协议不受支持或明显不可用的上游 API base 给出更清晰提示。
- 流式 fallback 策略：当前 fallback 发生在收到可重试状态或网络错误时；如果上游流已经开始，中途失败无法安全切换模型。

维护这类能力时，应优先补测试：路由规则改动补 `test/router.test.ts`，代理行为改动补 `test/proxy.test.ts`，OpenClaw 生命周期改动补 `test/plugin.test.ts`。
