# Xiaoyi Router

Xiaoyi Router is a small local routing proxy for OpenAI-compatible Chat Completions APIs.

It supports only three public model IDs:

- `auto`
- `deepseek-v4-flash`
- `deepseek-v4-pro`

`auto` is routed locally. Simple and ordinary code requests use `deepseek-v4-flash`; debugging, complex reasoning, long-context work, multi-file tasks, and code requests that actually need tool use route to `deepseek-v4-pro`.

## Install

```bash
npm install
npm run build
```

## Documentation

- [使用手册](./docs/usage.md)
- [开发文档](./docs/development.md)

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

Extra upstream headers:

```bash
export XIAOYI_ROUTER_HEADERS='{"X-Request-Source":"xiaoyi-router"}'
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
- `x-xiaoyi-router-routed`
- `x-xiaoyi-router-fallback`
- `x-xiaoyi-router-upstream`

## Phase 2 Candidate: Response Cache

Response caching is intentionally not included in v0.1.

It is reserved as a future opt-in cost optimization for non-streaming, deterministic requests. A cache key must include at least `model`, `messages`, `tools`, `temperature`, `max_tokens`, and `baseUrl`, and must distinguish `deepseek-v4-flash` from `deepseek-v4-pro`.
