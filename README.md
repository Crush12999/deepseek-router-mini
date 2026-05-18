# Xiaoyi Router

Xiaoyi Router is a small local routing proxy for OpenAI-compatible Chat Completions APIs.

## Public Model Semantics

Xiaoyi Router currently accepts exactly one client-facing request model ID: `auto`.

`config.publicModels` can still define aliases such as `flash` and `pro`, but those
aliases are internal routing vocabulary. They are used by `routing.tiers.*`, response
headers, traces, and diagnostics — not as public request IDs.

The sample `config.example.json` publishes:

- `flash`
- `pro`

These example aliases are not protocol constants. You can rename them, remove them,
or add more aliases as long as `auto` remains the router entry and
`routing.tiers.*.publicModel` points to alias entries.

`auto` is routed locally with a Flash-first policy. Simple summaries, short text,
ordinary Q&A, lightweight code edits, simple agentic work, and routine structured
output usually land on `flash`. Complex reasoning and natural multi-file debugging or
repair workflows usually land on `pro`. Longer context participates in routing
signals, but it no longer forces Pro by threshold alone.

Clients, OpenClaw, and SDK integrations should always send `auto`. Routed aliases
such as `flash` and `pro` appear in `x-xiaoyi-router-model`, traces, and internal
configuration only.

## Install

```bash
npm install
npm run build
```

## Documentation

- [使用手册](./docs/usage.md)
- [开发文档](./docs/development.md)
- [迁移指南](./docs/migration-guide.md)

## Reference Project

For related routing and OpenClaw ecosystem context, see
[BlockRunAI/ClawRouter](https://github.com/BlockRunAI/ClawRouter).

## OpenClaw Compatibility

For OpenClaw v2026.4.11 and v2026.3.24, Xiaoyi Router does not register a
`xiaoyiprovider` provider and does not declare providers in
`openclaw.plugin.json`.

When loaded by OpenClaw, the router still writes or repairs
`models.providers.xiaoyiprovider` so that:

- `baseUrl` points to the local router API, for example `http://127.0.0.1:8402/v1`.
- `api` is `openai-completions`.
- `models` only exposes `auto`, even if the routing config contains aliases such as
  `flash` and `pro`.

Existing `apiKey`, `api_key`, `headers`, `request`, and unknown provider fields are
preserved across Gateway restarts. The router only repairs its managed fields.

`xy_channel` is optional. If installed, it can provide and register the provider
implementation. Without `xy_channel`, Xiaoyi Router can still be used as a local
OpenAI-compatible routing service through the standard provider configuration above.

## CLI Usage

```bash
# 启动代理（必须提供配置文件）
xiaoyi-router --config config.json

# 自定义端口
xiaoyi-router --config config.json --port 9000

# Override API key
xiaoyi-router --config config.json --api-key sk-your-key
```

**注意**：v0.2.0 起不再支持环境变量配置（`XIAOYI_API_KEY`、`XIAOYI_BASE_URL`、`XIAOYI_ROUTER_HEADERS`、`XIAOYI_ROUTER_TRACE`），所有配置必须通过 `--config` 参数提供的配置文件指定。参考 `config.example.json` 创建配置文件。

## OpenClaw Plugin Usage

```bash
# 内联配置
openclaw config set plugins.entries.xiaoyi-router.config.config '{"version":1,...}'

# 文件路径
openclaw config set plugins.entries.xiaoyi-router.config.configPath "/path/to/config.json"
```

OpenClaw 应始终向本地 Router 请求 `auto`，再由 Router 在内部决定最终落到哪
个 alias / physical model。

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
Supported request IDs are currently only `auto`.
Configured aliases remain internal routing outputs and are surfaced via response
headers, not accepted in request bodies.

## Response Headers

The proxy adds routing headers:

- `x-xiaoyi-router-model`
- `x-xiaoyi-router-actual-model`
- `x-xiaoyi-router-tier`
- `x-xiaoyi-router-trace`
- `x-xiaoyi-router-routed`
- `x-xiaoyi-router-fallback`
- `x-xiaoyi-router-upstream`

`x-xiaoyi-router-model` is the routed alias chosen inside the router.
`x-xiaoyi-router-actual-model` is the physical upstream model ID used in the
forwarded request.

## Phase 2 Candidate: Response Cache

Response caching is intentionally not included in v0.2.0.

It is reserved as a future opt-in cost optimization for non-streaming,
deterministic requests. A cache key must include at least `model`, `messages`,
`tools`, `temperature`, `max_tokens`, and `baseUrl`, and it must distinguish
between routed aliases and the resolved physical upstream model.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
