# Xiaoyi Router

Xiaoyi Router is a small local routing proxy for OpenAI-compatible Chat Completions APIs.

It supports three public model IDs:

- `auto`
- `flash`
- `pro`

`auto` is routed locally with a Flash-first policy. Simple summaries, short text, ordinary Q&A, lightweight code edits, simple agentic work, and routine structured output default to `flash`. Complex reasoning and natural multi-file debugging or repair workflows default to `pro`. Longer context participates in routing signals, but it no longer forces Pro by threshold alone.

Explicit model requests take priority. Explicit `flash` requests stay on Flash; explicit `pro` requests stay on Pro.

## Install

```bash
npm install
npm run build
```

## Documentation

- [使用手册](./docs/usage.md)
- [开发文档](./docs/development.md)

## OpenClaw Compatibility

For OpenClaw v2026.4.11 and v2026.3.24, Xiaoyi Router does not register a
`xiaoyiprovider` provider and does not declare providers in
`openclaw.plugin.json`.

When loaded by OpenClaw, the router still writes or repairs
`models.providers.xiaoyiprovider` so that:

- `baseUrl` points to the local router API, for example `http://127.0.0.1:8402/v1`.
- `api` is `openai-completions`.
- `models` matches the router registry: `auto`, `deepseek-v4-flash`, and `deepseek-v4-pro`.

Existing `apiKey`, `api_key`, `headers`, `request`, and unknown provider fields
are preserved across Gateway restarts. The router only repairs its managed
fields.

`xy_channel` is optional. If installed, it can provide and register the provider
implementation. Without `xy_channel`, Xiaoyi Router can still be used as a local
OpenAI-compatible routing service through the standard provider configuration
above.

## CLI Usage

```bash
# 启动代理（必须提供配置文件）
xiaoyi-router --config config.json

# 自定义端口
xiaoyi-router --config config.json --port 9000

# Override API key
xiaoyi-router --config config.json --api-key sk-your-key
```

## OpenClaw Plugin Usage

```bash
# 内联配置
openclaw config set plugins.entries.xiaoyi-router.config.config '{"version":1,...}'

# 文件路径
openclaw config set plugins.entries.xiaoyi-router.config.configPath "/path/to/config.json"
```

## API

Implemented:

```text
GET  /health
POST /v1/chat/completions
```

Not implemented:

```text
GET /v1/models
```

Unsupported model IDs return HTTP 400.

## Response Headers

The proxy adds routing headers:

- `x-xiaoyi-router-model`
- `x-xiaoyi-router-tier`
- `x-xiaoyi-router-trace`
- `x-xiaoyi-router-routed`
- `x-xiaoyi-router-fallback`
- `x-xiaoyi-router-upstream`

## Phase 2 Candidate: Response Cache

Response caching is intentionally not included in v0.1.

It is reserved as a future opt-in cost optimization for non-streaming, deterministic requests. A cache key must include at least `model`, `messages`, `tools`, `temperature`, `max_tokens`, and `baseUrl`, and must distinguish `deepseek-v4-flash` from `deepseek-v4-pro`.
