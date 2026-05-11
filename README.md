# Xiaoyi Router

Xiaoyi Router is a small local routing proxy for OpenAI-compatible Chat Completions APIs.

It supports only three public model IDs:

- `auto`
- `deepseek-v4-flash`
- `deepseek-v4-pro`

`auto` is routed locally. Simple summaries, short text, and ordinary lightweight tasks default to `deepseek-v4-flash`. Complex reasoning, long-context requests, tool-intensive work, code or agentic tasks, and high-risk structured output default to `deepseek-v4-pro`.

Explicit model requests take priority. Explicit `deepseek-v4-flash` requests may fall back to `deepseek-v4-pro` on retryable failures; explicit `deepseek-v4-pro` requests are never downgraded.

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

## Run

```bash
export XIAOYI_API_KEY="your-api-key"
npm run build
node dist/cli.js
```

Custom upstream:

```bash
XIAOYI_BASE_URL="https://api.deepseek.com" node dist/cli.js --port 8402
```

The default upstream is `https://api.deepseek.com`. Set `XIAOYI_BASE_URL` to use another OpenAI-compatible upstream API base.

Extra upstream headers:

```bash
export XIAOYI_ROUTER_HEADERS='{"X-Request-Source":"xiaoyi-router"}'
```

`XIAOYI_API_KEY` is optional. When provided, the proxy sends `Authorization: Bearer <apiKey>` if the merged request headers do not already contain `Authorization`. When omitted, the proxy does not add `Authorization`. If request headers or configured headers already include `Authorization`, the current header merge semantics apply. `x-uid` can be passed through provider `headers` or `request.headers`.

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
- `x-xiaoyi-router-routed`
- `x-xiaoyi-router-fallback`
- `x-xiaoyi-router-upstream`

## Phase 2 Candidate: Response Cache

Response caching is intentionally not included in v0.1.

It is reserved as a future opt-in cost optimization for non-streaming, deterministic requests. A cache key must include at least `model`, `messages`, `tools`, `temperature`, `max_tokens`, and `baseUrl`, and must distinguish `deepseek-v4-flash` from `deepseek-v4-pro`.
