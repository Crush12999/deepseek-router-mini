# LLM Router 使用手册

本文面向两类读者：直接把 LLM Router 作为本地 OpenAI-compatible Chat
Completions 代理的用户，以及把它接入 OpenClaw Gateway 的运维者。

## 1. 核心概念

LLM Router 在 v0.2.0 里把「请求入口」和「路由结果」分成了两层：

- `auto` 是唯一对外可请求的 model，表示「交给本地 Router 决定」。
- `config.publicModels` 里除 `auto` 外的条目是**内部路由 alias**，例如示例
  配置中的 `flash` 和 `pro`。
- 这些 alias 用于 `routing.tiers.*`、响应头、trace 和诊断信息，不作为客户端
  请求入口。
- `models[].id` 直接就是实际上游请求使用的 physical model 名称。

因此，请把下面 3 个概念区分开：

- request model：客户端请求体里的 `model`。当前固定只能是 `auto`。
- routed alias：Router 内部根据规则挑选出的语义层模型，例如 `flash`、`pro`、
  `lite`、`think`。
- physical model：真正转发给上游时写入请求体的模型名，例如
  `deepseek-v4-flash`、`deepseek-v4-pro`。

## 2. 配置文件

CLI 必须使用 `--config`；OpenClaw 插件固定读取当前用户目录下的默认配置文件，
缺失或非法时会进入内置默认配置兜底。默认配置文件名为 `.openclaw/llm-router-config.json`，位于当前用户目录下。

示例配置：

```json
{
  "version": 1,
  "proxy": {
    "port": 8402,
    "upstreamUrl": "https://api.deepseek.com",
    "trace": "off"
  },
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "inputPrice": 0.28,
      "outputPrice": 0.42,
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "reasoning": true,
      "toolCalling": true
    },
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "inputPrice": 0.56,
      "outputPrice": 1.68,
      "contextWindow": 1000000,
      "maxOutput": 64000,
      "reasoning": true,
      "toolCalling": true
    }
  ],
  "publicModels": {
    "auto": {
      "kind": "router",
      "metadata": {
        "name": "LLM Router Auto",
        "reasoning": true,
        "contextWindow": 1000000,
        "maxTokens": 64000,
        "cost": {
          "input": 0.28,
          "output": 0.42,
          "cacheRead": 0.07,
          "cacheWrite": 0.28
        }
      }
    },
    "flash": {
      "kind": "alias",
      "candidates": ["deepseek-v4-flash"],
      "selection": "first"
    },
    "pro": {
      "kind": "alias",
      "candidates": ["deepseek-v4-pro"],
      "selection": "first"
    }
  },
  "routing": {
    "tiers": {
      "SIMPLE": { "publicModel": "flash" },
      "MEDIUM": { "publicModel": "flash", "fallback": ["pro"] },
      "COMPLEX": { "publicModel": "pro" },
      "REASONING": { "publicModel": "pro" }
    },
    "structuredOutputMinTier": "MEDIUM",
    "ambiguousDefaultTier": "MEDIUM"
  }
}
```

配置要点：

- `models[].id` 必须是上游真实模型名。
- `publicModels.auto` 必须存在，且 `kind` 必须是 `router`。
- `routing.tiers.*.publicModel` 和 `fallback[]` 只能引用 alias 类型的 public
  model。
- 如果你希望新增 `lite` / `think` / `debug` 之类的新 alias，只需要改
  `publicModels` 和 `routing`；客户端请求入口仍然保持为 `auto`。

OpenClaw 插件模式额外提供启动兜底：如果默认配置文件缺失或非法，插件会回退到内置默认配置，确保本地
Router 仍能启动。该兜底配置不包含真实 `apiKey`，上游鉴权仍需要通过
OpenClaw provider 配置、插件运行时覆盖或其他受支持的方式提供。

进入内置默认配置兜底时，插件会加入内置默认 header：
`x-request-from: openclaw`。`pluginConfig.defaultHeaders` 可以补充或覆盖这
一兜底层 headers；但只在 `config.source === "default"` 时生效。只要
默认配置文件合法，即便配置了 `defaultHeaders` 也完全不使用。

插件还可以把配置的 `.xiaoyienv` 文件作为兜底补充读取：

```env
SERVICE_URL=https://api.deepseek.com
PERSONAL-API-KEY=sk-example
PERSONAL-UID=123456
```

- `SERVICE_URL` 仅用于补充兜底配置的上游 URL。
- 其他 key 只有通过 `pluginConfig.xiaoyiEnv.headerMap` 映射后才会作为 header
  使用；默认映射是 `{ "PERSONAL-API-KEY": "x-api-key", "PERSONAL-UID": "x-uid" }`。

配置优先级摘要：

1. 合法的默认配置文件优先于内置默认配置。
2. openclaw.json 中残留的 `pluginConfig.config` / `pluginConfig.configPath` 会被忽略。
3. 只有主配置缺失或非法时，`SERVICE_URL` 才会补充兜底配置的
   `proxy.upstreamUrl`。
4. 默认配置文件合法时，headers 优先级是：`.xiaoyienv` 映射 headers <
   默认配置文件中的 `RawConfig.proxy.headers` < provider/request headers。
5. 默认兜底场景下，headers 优先级是：内置默认 headers <
   `pluginConfig.defaultHeaders` < `.xiaoyienv` 映射 headers < provider/request
   headers。
6. 同名 header 按大小写不敏感规则由更高优先级来源覆盖。
7. `pluginConfig.port`、`pluginConfig.upstreamUrl`、`pluginConfig.trace`
   属于运行时覆盖项，优先级高于主配置和 `.xiaoyienv`。

### 2.1 Routing thresholds

路由评分阈值属于内置启动常量，不属于公开配置面。配置文件只应通过
`routing.tiers`、`structuredOutputMinTier` 和 `ambiguousDefaultTier` 控制路由
结果。

下列参数不应写进 `config.json`：

- tier boundaries
- confidence threshold
- dimension weights
- keyword lists
- token thresholds
- confidence steepness

这些参数属于 `src/router/config.ts` 里的实现常量；当前版本不提供外部覆写口。

## 3. 快速开始

### 3.1 独立代理

```bash
cd /path/to/llm-router
npm install
npm run build
llm-router --config config.json
```

健康检查：

```bash
curl -sS http://127.0.0.1:8402/health
```

预期响应：

```json
{
  "status": "ok",
  "baseUrl": "https://api.deepseek.com",
  "version": "1.0.5",
  "degraded": false,
  "config": {
    "source": "file",
    "envFileLoaded": false
  }
}
```

### 3.2 OpenClaw 插件

默认配置文件名为 `.openclaw/llm-router-config.json`，位于当前用户目录下。
更新该文件后重启 OpenClaw Gateway 即可；不要通过 `openclaw config set` 写入 `config` 或 `configPath`。

插件不会注册 provider，也不会在 manifest 中声明 providers。它只负责写入或
修复 `models.providers.xiaoyiprovider`，并把 OpenClaw 对外可见的模型列
表收敛为 `auto`。

补充说明：`plugins.entries.llm-router.config.port` 与 `upstreamUrl` 是可选运行时覆写项；若未显式配置，则沿用默认配置文件或内置兜底配置中的 `proxy.port` 与 `proxy.upstreamUrl`。

当插件进入内置默认配置兜底时，`GET /health` 仍返回低泄漏摘要：`degraded`
为 `true`，`config.source` 为 `default`，`config.fallbackReason` 只包含稳定
枚举（例如 `config_path_not_found`、`config_json_parse_error`），不会暴露原始异常
详情。`config.envFileLoaded` 只在 `.xiaoyienv` 的 `SERVICE_URL` 或映射后的
header 最终实际生效时为 `true`；如果文件不存在、读取失败，或相关值被更高优
先级配置覆盖，则保持 `false`。`pluginConfig.defaultHeaders` 不影响
`config.envFileLoaded`，`/health` 也不会暴露 headers 内容、数量或是否配置。

运行时保护默认值目前不是公开配置字段，配置文件中无需填写：

| 保护项         | 默认值 | 行为                                                 |
| -------------- | -----: | ---------------------------------------------------- |
| 请求体大小上限 |  10 MB | 超限返回 `413 Payload Too Large`，不会转发到上游。   |
| 请求体读取超时 |  30 秒 | 客户端迟迟不发完 body 时返回 `408 Request Timeout`。 |
| 上游请求超时   | 300 秒 | 主动 abort 上游请求并返回 `504 Gateway Timeout`。    |

如果客户端在上游响应前断开连接，代理会取消对应的上游请求，避免旧请求继续占用资源。

## 4. HTTP API

已实现：

```text
GET  /health
POST /v1/chat/completions
```

未实现：

```text
GET /v1/models
```

不支持的 model ID 会返回 `400`。当前 HTTP 请求边界固定只接受：

```text
auto
```

即使配置里存在 `flash` / `pro` / `lite` / `think` 等 alias，它们也只用于
路由决策和响应头，不接受显式请求。

### 4.1 `POST /v1/chat/completions`

最小请求：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Translate hello to Chinese."
      }
    ]
  }'
```

复杂任务示例：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Debug this failing Vitest suite across multiple files."
      }
    ]
  }'
```

在示例配置下，简单请求通常会把 `x-xy-router-model` 路由成 `flash`，复杂请
求通常会路由成 `pro`，但客户端请求体里的 `model` 始终应该是 `auto`。

## 5. 响应头

代理会添加以下响应头：

| 响应头                     | 含义                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `x-xy-router-model`        | Router 内部最终选中的 alias，也就是语义层路由结果。                        |
| `x-xy-router-actual-model` | physical / upstream model，也就是实际发往上游请求体的真实模型名。          |
| `x-xy-router-tier`         | 当前请求最终落到的 tier，例如 `SIMPLE`、`MEDIUM`、`COMPLEX`、`REASONING`。 |
| `x-xy-router-trace`        | 紧凑路由摘要，例如 `auto:medium:flash:first-pass`。                        |
| `x-xy-router-routed`       | 是否经过 `auto` 路由。当前成功请求通常为 `true`。                          |
| `x-xy-router-fallback`     | 是否发生 fallback。当前实现固定为 `false`。                                |
| `x-xy-router-upstream`     | 当前代理配置的上游 API base。                                              |

示例：

```text
x-xy-router-model: flash
x-xy-router-actual-model: deepseek-v4-flash
x-xy-router-tier: MEDIUM
x-xy-router-trace: auto:medium:flash:first-pass
x-xy-router-routed: true
x-xy-router-fallback: false
```

解释：

- `x-xy-router-model=flash` 表示本次请求在 Router 内部被判定为适合 `flash`
  这个 alias。
- `x-xy-router-actual-model=deepseek-v4-flash` 表示真正发往上游的请求体已经
  把 `model` 改写成了 `deepseek-v4-flash`。

## 6. OpenClaw provider 模型注入

OpenClaw provider 的元数据仍然来自运行时配置：

- `config.publicModels`
- `config.models`

但真正写入 `models.providers.xiaoyiprovider.models` 时，当前只暴露一个对外可
请求条目：

```text
auto
```

这意味着：

- OpenClaw 统一向本地 Router 请求 `auto`。
- `flash` / `pro` / `lite` / `think` 之类的 alias 留在 Router 内部使用。
- 你仍然可以通过响应头观察最终实际命中的 alias 和 physical model。

## 7. 错误响应

错误响应统一为 OpenAI-compatible 结构：

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

常见场景：

| 场景                          | HTTP 状态码 | 说明                                            |
| ----------------------------- | ----------: | ----------------------------------------------- |
| JSON 解析失败                 |       `400` | `error.message` 为 `Invalid JSON body`          |
| 请求体不是 JSON 对象          |       `400` | `error.message` 为 `Body must be a JSON object` |
| 请求体过大                    |       `413` | 默认上限为 10 MB                                |
| 请求体读取超时                |       `408` | 默认 30 秒内必须发完 body                       |
| 模型 ID 不支持                |       `400` | 当前固定返回 `Supported models: auto`           |
| 未实现路径，例如 `/v1/models` |       `404` | `error.message` 为 `Not Found`                  |
| 上游请求超时                  |       `504` | 默认 300 秒，超时会 abort 上游请求              |
| 上游网络错误                  |       `502` | 尽量附带路由响应头                              |
| 代理内部未捕获错误            |       `502` | 返回统一错误结构                                |

## 8. OpenClaw 排查要点

### 8.1 确认 provider 已修复

```bash
openclaw plugins inspect llm-router --json
openclaw config get models.providers.xiaoyiprovider
```

关键字段应包含：

```text
baseUrl: http://127.0.0.1:8402/v1
api: openai-completions
models: auto
```

即使你的路由配置里定义了 `flash` / `pro` 或别的 alias，这里也应该只看到
`auto`。这是当前实现的预期行为。

### 8.2 确认最终实际模型

OpenClaw agent CLI 不一定会展示代理追加的响应头。要确认最终到底走了哪个
alias / physical model，优先直接请求本地代理并查看：

- `x-xy-router-model`
- `x-xy-router-actual-model`
- `x-xy-router-tier`

### 8.3 401 / 403

优先检查以下来源是否至少有一个提供了有效鉴权：

- 请求 Header 中的 `Authorization`
- `config.proxy.apiKey`
- `models.providers.xiaoyiprovider.apiKey`
- `models.providers.xiaoyiprovider.api_key`

OpenClaw provider 还可以透传：

- `models.providers.xiaoyiprovider.headers`
- `models.providers.xiaoyiprovider.request.headers`

其中 `request.headers` 会覆盖同名 provider header。

## 9. 验证建议

建议至少执行：

```bash
npm test -- test/package-metadata.test.ts
npm run lint
npm run typecheck
```

如果要做手工请求验证，建议至少覆盖下面 3 项：

1. `auto` 请求是否返回 `x-xy-router-model` 和
   `x-xy-router-actual-model`。
2. 显式请求 `flash` / `pro` 等 alias 时是否返回 `400`，并提示
   `Supported models: auto`。
3. OpenClaw `models.providers.xiaoyiprovider.models` 是否只暴露 `auto`。
