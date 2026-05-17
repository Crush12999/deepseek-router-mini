# Xiaoyi Router 使用手册

本文面向两类读者：直接把 Xiaoyi Router 作为本地 OpenAI-compatible
Chat Completions 代理的用户，以及把它接入 OpenClaw Gateway 的运维者。

## 1. 核心概念

Xiaoyi Router 在 v0.2.0 起完全采用配置驱动的模型合同。

- `auto` 是唯一固定保留的 public model，表示“交给本地路由器决定”。
- 除 `auto` 外，公开模型 ID 全部来自 `config.publicModels`。
- `config.example.json` 里的 `flash` 和 `pro` 只是示例 alias，不是硬编码
  协议常量。
- `models[].id` 直接就是实际上游请求使用的 model 名。
- v0.2.0 配置格式不包含 `upstreamModel` 字段。

因此，请把“公开模型”与“真实上游模型”视为两层概念：

- public model：客户端请求时填写的 `model`，例如 `auto`、`flash`、`pro`
  或你自定义的 alias。
- physical model：实际转发给上游时放进请求体的真实模型名，例如
  `deepseek-v4-flash`、`deepseek-v4-pro`。

## 2. 配置文件

CLI 必须使用 `--config`，OpenClaw 插件必须提供
`pluginConfig.config` 或 `pluginConfig.configPath`。

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
        "name": "Xiaoyi Auto",
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
      "candidates": ["deepseek-v4-flash"]
    },
    "pro": {
      "kind": "alias",
      "candidates": ["deepseek-v4-pro"]
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
- `routing.tiers.*.publicModel` 和 `fallback[]` 只能引用 alias 类型的
  public model。
- 如果你希望公开 `lite` / `think` / `debug` 之类的新别名，只需要改
  `publicModels` 和 `routing`，不需要修改协议常量。

## 3. 快速开始

### 3.1 独立代理

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
node dist/cli.js --config config.json
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
  "version": "0.2.0"
}
```

### 3.2 OpenClaw 插件

内联配置：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.config '{"version":1,...}'
openclaw gateway restart
```

文件路径：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.configPath "/path/to/config.json"
openclaw gateway restart
```

插件不会注册 `xiaoyiprovider` provider，也不会在 manifest 中声明
providers。它只负责写入或修复 `models.providers.xiaoyiprovider`，并把
provider 模型目录同步为当前配置导出的 public models。

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

不支持的 model ID 会返回 `400`。支持列表始终等于：

```text
Object.keys(config.publicModels)
```

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

示例配置下，显式 alias 请求可以这样写：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "flash",
    "messages": [
      {
        "role": "user",
        "content": "Write a short summary."
      }
    ]
  }'
```

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "pro",
    "messages": [
      {
        "role": "user",
        "content": "Debug this failing Vitest suite across multiple files."
      }
    ]
  }'
```

请注意，上面 `flash` / `pro` 只是示例配置中的 public alias。若你的
`config.publicModels` 使用其他名字，请按实际配置请求。

## 5. 响应头

代理会添加以下响应头：

| 响应头                             | 含义 |
| ---------------------------------- | ---- |
| `x-xiaoyi-router-model`            | routed public model，也就是路由后暴露给客户端语义层的模型 ID。 |
| `x-xiaoyi-router-actual-model`     | physical / upstream model，也就是实际发往上游请求体的真实模型名。 |
| `x-xiaoyi-router-tier`             | 当前请求最终落到的 tier，例如 `SIMPLE`、`MEDIUM`、`COMPLEX`、`REASONING`。 |
| `x-xiaoyi-router-trace`            | 紧凑路由摘要，例如 `auto:medium:flash:first-pass`。 |
| `x-xiaoyi-router-routed`           | 是否经过 `auto` 路由。 |
| `x-xiaoyi-router-fallback`         | 是否发生 fallback。当前实现固定为 `false`。 |
| `x-xiaoyi-router-upstream`         | 当前代理配置的上游 API base。 |

示例：

```text
x-xiaoyi-router-model: flash
x-xiaoyi-router-actual-model: deepseek-v4-flash
x-xiaoyi-router-tier: MEDIUM
x-xiaoyi-router-trace: auto:medium:flash:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-fallback: false
```

解释：

- `x-xiaoyi-router-model=flash` 表示本次请求在 public 层被路由到了
  `flash` 这个 alias。
- `x-xiaoyi-router-actual-model=deepseek-v4-flash` 表示真正发往上游的
  请求体里 `model` 已经被改写成 `deepseek-v4-flash`。

## 6. OpenClaw provider 模型注入

OpenClaw provider 的 `models` 目录不再来自静态常量
`XIAOYI_OPENCLAW_MODELS`。当前实现会根据：

- `config.publicModels`
- `config.models`

动态生成 `models.providers.xiaoyiprovider.models`。

示例配置下，provider 模型目录通常包含：

```text
auto
flash
pro
```

如果你把 alias 改成 `lite` / `think`，那么 provider 模型目录也会随配置
变成：

```text
auto
lite
think
```

## 7. 错误响应

错误响应统一为 OpenAI-compatible 结构：

```json
{
  "error": {
    "message": "Unknown model \"foo\". Supported models: auto, flash, pro",
    "type": "invalid_request_error",
    "param": null,
    "code": "model_not_found"
  }
}
```

常见场景：

| 场景 | HTTP 状态码 | 说明 |
| ---- | ----------: | ---- |
| JSON 解析失败 | `400` | `error.message` 为 `Invalid JSON body` |
| 请求体不是 JSON 对象 | `400` | `error.message` 为 `Body must be a JSON object` |
| 模型 ID 不支持 | `400` | 支持列表来自当前 `publicModels` |
| 未实现路径，例如 `/v1/models` | `404` | `error.message` 为 `Not Found` |
| 上游网络错误 | `502` | 尽量附带路由响应头 |
| 代理内部未捕获错误 | `502` | 返回统一错误结构 |

## 8. OpenClaw 排查要点

### 8.1 确认 provider 已修复

```bash
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
```

关键字段应包含：

```text
baseUrl: http://127.0.0.1:8402/v1
api: openai-completions
models: auto, flash, pro
```

如果你的配置里公开 alias 不是 `flash` / `pro`，这里看到的模型列表也会不
一样。这是正常现象。

### 8.2 确认最终实际模型

OpenClaw agent CLI 不一定会展示代理追加的响应头。要确认最终到底走了哪个
physical model，优先直接请求本地代理并查看：

- `x-xiaoyi-router-model`
- `x-xiaoyi-router-actual-model`

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
npx tsc --noEmit --pretty false
```

如果要做手工请求验证，建议分别准备一个“简单任务”和一个“复杂任务”，并比
较返回的：

- `x-xiaoyi-router-model`
- `x-xiaoyi-router-actual-model`
- `x-xiaoyi-router-tier`

这样能同时验证 public alias 路由与真实上游模型解析是否一致。
