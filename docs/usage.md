# DeepSeek Router Mini 使用手册

本文面向两类读者：直接将 DeepSeek Router Mini 作为本地 OpenAI 兼容代理的用户，以及把它接入 OpenClaw Gateway 的运维者。文档中的命令均使用占位路径，请把 `/path/to/deepseek-router-mini` 替换为你的实际项目目录，不要把真实 API Key 写入文档、脚本仓库或终端历史。

## 适用场景与能力边界

DeepSeek Router Mini 是一个轻量本地路由代理。它对本地 HTTP 客户端和 OpenClaw 暴露 `POST /v1/chat/completions`，再根据请求中的模型 ID 与提示词特征，把请求转发到 `upstreamBaseUrl + /chat/completions`。

本地 Router API 和上游 API base 是两层概念，必须分离：

- 本地 Router API：固定使用 `POST /v1/chat/completions`；`GET /health` 保留；`GET /v1/models` 当前未实现。
- OpenClaw Provider 的 `models.providers.deepseek.baseUrl`：本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。
- 上游 API base：实际转发到 DeepSeek 兼容上游时使用，优先级是 `pluginConfig.upstreamUrl` > `DEEPSEEK_BASE_URL` > `https://api.deepseek.com`。

实际上游请求 URL 按 `trimTrailingSlash(upstreamBaseUrl) + /chat/completions` 生成。上游 `baseUrl` 是否带 `/v1`、`/v4` 或不带版本，由用户配置决定；项目不自动追加版本段、不猜 provider、不根据域名分支。`upstreamUrl` 或 `DEEPSEEK_BASE_URL` 不要包含完整资源路径 `/chat/completions`。

适合使用的场景：

- 希望在本地暴露一个稳定的 OpenAI 兼容 Chat Completions 入口。
- 希望只向使用者暴露 `auto`、`deepseek-v4-flash`、`deepseek-v4-pro` 这 3 个模型 ID。
- 希望普通任务优先使用 Flash，复杂任务、调试任务、长上下文任务和真正需要工具的代码任务自动升级到 Pro。
- 希望把本地代理作为 OpenClaw 插件安装，让 OpenClaw 的 `deepseek` provider 指向本地代理。
- 希望用响应头观察一次请求最终路由到了 Flash 还是 Pro。

当前能力边界：

- 只实现 `GET /health` 和 `POST /v1/chat/completions`。
- 不实现 `GET /v1/models`，访问该路径会返回 `404`。
- 只接受 `auto`、`deepseek-v4-flash`、`deepseek-v4-pro`，其他模型 ID 会返回 `400`。
- 不缓存响应。响应缓存是后续候选能力，当前版本没有实现。
- 不管理真实 DeepSeek API Key。API Key 通过环境变量、OpenClaw provider 配置或请求头传入。
- 不自动切换监听端口。端口被占用时需要显式改端口并重启。
- 不改写 OpenClaw auth profile，也不创建 OpenClaw 专属鉴权向导。

## 环境要求

### Node.js

项目 `package.json` 声明的运行要求为 Node.js `>=20`。建议先确认版本：

```bash
node --version
npm --version
```

如果 `node --version` 低于 `v20.0.0`，请先升级 Node.js。

### OpenClaw

OpenClaw 集成模式需要本机可用 `openclaw` CLI，并且 Gateway 能正常启动。常用检查命令：

```bash
openclaw --version
openclaw gateway status
```

插件安装、registry 刷新、Gateway 重启和 agent 管理会用到这些命令：

```bash
openclaw plugins install <path-or-package>
openclaw plugins registry --refresh
openclaw gateway restart
openclaw agents add <name> --workspace <dir> --agent-dir <dir> --model <model-id> --non-interactive
```

### DeepSeek API Key

独立代理模式通常使用 `DEEPSEEK_API_KEY`：

```bash
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"
```

OpenClaw 插件模式可以使用 OpenClaw 的 `models.providers.deepseek.apiKey` 或 `models.providers.deepseek.api_key`，也可以继续使用环境变量兜底。不要在示例、日志或 issue 中粘贴真实 Key。

## 安装方式

### 源码安装

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
```

构建产物位于 `dist/`。CLI 入口为 `dist/cli.js`，包导出的 OpenClaw 插件入口为 `dist/index.js`。

### 本地开发构建

开发时可以使用 watch 模式：

```bash
cd /path/to/deepseek-router-mini
npm run dev
```

运行正式验证或打包前仍建议执行一次普通构建：

```bash
npm run build
```

### npm pack

项目的 `package.json` 会把 `dist`、`README.md`、`openclaw.plugin.json` 纳入发布文件。打本地包前先构建：

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
printf '%s\n' "${PACKAGE_TGZ}"
```

输出类似：

```text
deepseek-router-mini-0.1.0.tgz
```

可以检查包内容：

```bash
tar -tf "${PACKAGE_TGZ}" | sort
```

应能看到类似条目：

```text
package/README.md
package/dist/index.js
package/openclaw.plugin.json
package/package.json
```

### 本地 OpenClaw 插件安装

从源码目录安装本地包：

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install "./${PACKAGE_TGZ}" --force
openclaw plugins registry --refresh
openclaw gateway restart
```

如果 OpenClaw 安全扫描拦截安装，并且你确认正在安装本仓库刚构建的本地包，可以临时加上 `--dangerously-force-unsafe-install`。

如果你的 OpenClaw 版本支持直接安装本地目录，也可以使用：

```bash
openclaw plugins install /path/to/deepseek-router-mini --force
openclaw plugins registry --refresh
openclaw gateway restart
```

安装后确认插件可见：

```bash
openclaw plugins list --json
openclaw plugins inspect deepseek-router-mini --json
```

如果需要查看运行时注册结果，可尝试：

```bash
openclaw plugins inspect deepseek-router-mini --runtime --json
```

## 快速开始

### 独立代理模式

独立代理模式不依赖 OpenClaw，适合先确认代理本身可以工作。

1. 构建项目：

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
```

2. 启动本地代理：

```bash
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"
node dist/cli.js
```

默认监听地址为：

```text
http://127.0.0.1:8402
```

启动成功时终端会输出：

```text
deepseek-router-mini listening on http://127.0.0.1:8402
```

3. 健康检查：

```bash
curl -sS http://127.0.0.1:8402/health
```

示例响应：

```json
{
  "status": "ok",
  "baseUrl": "https://api.deepseek.com",
  "version": "0.1.0"
}
```

4. 发送一次 `auto` 请求：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Summarize briefly: OpenClaw routes simple tasks."
      }
    ]
  }'
```

在响应头中查看最终模型：

```text
x-deepseek-router-model: deepseek-v4-flash
x-deepseek-router-routed: true
x-deepseek-router-fallback: false
```

### OpenClaw 插件模式

OpenClaw 插件模式会在插件注册时注入 `deepseek` provider，并把 OpenClaw 对 `deepseek/auto`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 的请求指向本地代理。

1. 构建并安装插件：

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install "./${PACKAGE_TGZ}" --force
openclaw plugins registry --refresh
openclaw gateway restart
```

2. 确认 Gateway 运行：

```bash
openclaw gateway status
```

3. 确认插件和模型可见：

```bash
openclaw plugins list --json
openclaw plugins inspect deepseek-router-mini --json
openclaw models list
```

应能看到下列模型 ID，具体显示格式以 OpenClaw 版本为准：

```text
deepseek/auto
deepseek/deepseek-v4-flash
deepseek/deepseek-v4-pro
```

4. 创建一个使用 `deepseek/auto` 的 agent：

```bash
openclaw agents add deepseek-router \
  --workspace /tmp/openclaw-deepseek-router-workspace \
  --agent-dir /tmp/openclaw-deepseek-router-agent \
  --model deepseek/auto \
  --non-interactive
```

5. 发起一次 agent 调用：

```bash
openclaw agent \
  --agent deepseek-router \
  --message "Summarize briefly: OpenClaw routes simple tasks."
```

也可以把 agent 放在固定目录，方便后续重复调用：

```bash
openclaw agents add deepseek-router \
  --workspace ~/.openclaw/workspace-deepseek-router \
  --agent-dir ~/.openclaw/agents/deepseek-router \
  --model deepseek/auto \
  --non-interactive
```

## 模型说明

本项目公开 3 个模型 ID：

| 模型 ID             | 类型         | 上游实际模型          | 场景                                                 |
| ------------------- | ------------ | --------------------- | ---------------------------------------------------- |
| `auto`              | 路由模型     | 自动选择 Flash 或 Pro | 推荐给 OpenClaw 和普通使用者，按任务自动路由。       |
| `deepseek-v4-flash` | 真实上游模型 | `deepseek-v4-flash`   | 简单任务、标准问答、普通代码生成、成本敏感调用。     |
| `deepseek-v4-pro`   | 真实上游模型 | `deepseek-v4-pro`     | 调试、架构、重构、多文件、长上下文、工具型代码编辑。 |

模型元数据来自源码中的 `DEEPSEEK_MODELS`：

| 模型 ID             | 上下文窗口 | 最大输出 | Reasoning | Tool calling | 输入价格元数据 | 输出价格元数据 |
| ------------------- | ---------: | -------: | --------- | ------------ | -------------: | -------------: |
| `auto`              |    1000000 |    64000 | 是        | 是           |              0 |              0 |
| `deepseek-v4-flash` |    1000000 |    64000 | 是        | 是           |           0.28 |           0.42 |
| `deepseek-v4-pro`   |    1000000 |    64000 | 是        | 是           |           0.56 |           1.68 |

价格字段是项目暴露给 OpenClaw 的模型元数据，不等同于供应商实时账单承诺。生产计费以 DeepSeek 或你的兼容上游为准。

## 自动路由说明

只有请求模型为 `auto` 时才会执行自动路由。显式请求 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时，代理会直接使用对应上游模型，并把 `x-deepseek-router-routed` 设为 `false`。

### 简单任务

包含翻译、总结、格式化、简短解释等意图时，路由到 Flash。匹配示例包括：

- `Translate hello to Chinese`
- `Summarize this briefly`
- `格式化这段文本`
- `总结下面内容`

### 标准任务

没有命中特定复杂度规则的普通请求会路由到 Flash。例如：

```text
How are you doing today?
```

### 代码任务

普通代码生成默认仍路由到 Flash。例如：

```text
Write a TypeScript function that sums numbers.
```

如果请求包含代码意图并且请求体带有非空 `tools` 数组，则路由到 Pro。典型场景：

```json
{
  "model": "auto",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "apply_patch"
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Use apply_patch to rename a symbol in src/plugin.ts"
    }
  ]
}
```

### 复杂任务

包含调试、失败测试、架构、重构、多文件、根因分析等特征时，路由到 Pro。复杂规则优先级高于简单规则和代码规则。例如：

```text
Debug and explain briefly this failing test.
```

虽然包含 `explain briefly`，但由于同时包含 `Debug` 和 `failing test`，最终按复杂任务处理。

### 长上下文

当估算输入长度达到 `120000` 字符及以上时，路由到 Pro。估算长度由消息文本加系统提示词长度构成。

### 工具与 OpenClaw bootstrap 场景

OpenClaw agent 经常会在请求中附带工具列表，或者在消息里包含 bootstrap 内容。代理有两条保护逻辑：

- 只有「代码任务 + 实际带工具」才因为工具升级到 Pro。简单总结、翻译等请求即使带着环境工具，也保持在 Flash。
- 对 OpenClaw CLI 风格的多轮包装消息，代理会优先使用最后一个用户回合做路由判断，避免被前面的 bootstrap 文本误导。

示例：即使请求体带有 `apply_patch` 工具，只要最终用户任务是简短总结，也会路由到 Flash。

### 会话钉住

`auto` 请求默认开启会话钉住（session pinning）。代理会根据请求头 `x-session-id` 或首段消息内容派生会话 ID。当某个会话路由或回退到 Pro 后，同一会话后续 `auto` 请求会继续使用 Pro，避免一段复杂会话在 Flash 和 Pro 之间来回跳动。

建议 OpenClaw 或调用方显式传入稳定的 `x-session-id`：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: session-pro' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Debug failing tests across multiple files."
      }
    ]
  }'
```

## 配置说明

### 环境变量

| 环境变量                  | 作用                                                                                    | 默认值                     |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `DEEPSEEK_API_KEY`        | 上游 API Key。请求未自带 `Authorization` 时，代理会补充 `Authorization: Bearer <key>`。 | 无                         |
| `DEEPSEEK_BASE_URL`       | 上游 API base。代理会去掉末尾多余 `/`，再追加 `/chat/completions`。                     | `https://api.deepseek.com` |
| `DEEPSEEK_ROUTER_PORT`    | 本地监听端口。必须是 `1` 到 `65535` 之间的整数。                                        | `8402`                     |
| `DEEPSEEK_ROUTER_HEADERS` | 额外上游请求头，JSON 对象，值必须是字符串。                                             | `{}`                       |

示例：

```bash
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"
export DEEPSEEK_BASE_URL="https://api.deepseek.com"
export DEEPSEEK_ROUTER_PORT="8402"
export DEEPSEEK_ROUTER_HEADERS='{"X-Request-Source":"deepseek-router-mini"}'
node dist/cli.js
```

上游 API base 示例：

| `upstreamBaseUrl`                | 实际上游请求 URL                                  |
| -------------------------------- | ------------------------------------------------- |
| `https://api.deepseek.com`       | `https://api.deepseek.com/chat/completions`       |
| `https://gateway.example.com/v1` | `https://gateway.example.com/v1/chat/completions` |
| `https://gateway.example.com/v4` | `https://gateway.example.com/v4/chat/completions` |

`DEEPSEEK_ROUTER_HEADERS` 必须是 JSON 对象，且每个 header 值必须是字符串。以下写法会在解析配置时抛错：

```bash
export DEEPSEEK_ROUTER_HEADERS='["not", "object"]'
export DEEPSEEK_ROUTER_HEADERS='{"X-Test":123}'
```

### CLI 参数

CLI 支持：

```bash
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js --port 9000
node dist/cli.js --base-url https://api.deepseek.com
```

参数说明：

| 参数               | 作用                           |
| ------------------ | ------------------------------ |
| `--help`、`-h`     | 输出帮助并退出。               |
| `--version`、`-v`  | 输出版本并退出。               |
| `--port <number>`  | 覆盖本地监听端口。             |
| `--base-url <url>` | 覆盖 DeepSeek 兼容上游 API base。 |

CLI 参数优先于环境变量中的同类配置。

### OpenClaw pluginConfig

`openclaw.plugin.json` 定义了两个插件配置项：

```json
{
  "port": 8402,
  "upstreamUrl": "https://api.deepseek.com"
}
```

在 OpenClaw 配置中，插件配置通常位于 `plugins.entries.deepseek-router-mini.config`。示例：

```json
{
  "plugins": {
    "entries": {
      "deepseek-router-mini": {
        "enabled": true,
        "config": {
          "port": 8402,
          "upstreamUrl": "https://api.deepseek.com"
        }
      }
    }
  }
}
```

优先级为：

1. `pluginConfig.port`、`pluginConfig.upstreamUrl`
2. `DEEPSEEK_ROUTER_PORT`、`DEEPSEEK_BASE_URL`
3. 默认值 `8402`、`https://api.deepseek.com`

### OpenClaw provider 配置

插件注册时会注入或修复：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "baseUrl": "http://127.0.0.1:8402/v1",
        "api": "openai-completions",
        "apiKey": "sk-your-deepseek-api-key",
        "models": []
      }
    }
  }
}
```

注意：

- `models.providers.deepseek.baseUrl` 是本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。
- OpenClaw 的 `openai-completions` 适配器会在该 `baseUrl` 后追加 `/chat/completions`，最终落到本插件的 `POST /v1/chat/completions`。
- `upstreamUrl` 或 `DEEPSEEK_BASE_URL` 是真实 DeepSeek 兼容上游 API base，不带 `/chat/completions`。
- 实际转发到上游时，绝不能使用 OpenClaw Provider 的 `baseUrl`；只能使用插件运行时上游 API base。
- 插件会保留已有的 `apiKey`、`headers` 和未知字段，只修复 `baseUrl`、`api` 和 `models` 等托管字段。
- 如果 `apiKey` 不存在，插件不会凭空创建真实 Key。

插件启动代理时会读取下列 provider 字段作为运行时覆盖：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "apiKey": "sk-your-deepseek-api-key",
        "headers": {
          "X-Provider": "yes"
        },
        "request": {
          "headers": {
            "X-Request": "yes"
          }
        }
      }
    }
  }
}
```

也支持下划线形式：

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "api_key": "sk-your-deepseek-api-key"
      }
    }
  }
}
```

header 合并规则：

- `models.providers.deepseek.headers` 会传给代理。
- `models.providers.deepseek.request.headers` 会传给代理，并覆盖同名 provider header。
- 非字符串 header 值会被忽略。
- 这些 header 会覆盖调用请求中的同名 header。
- 如果最终 header 中没有 `Authorization`，且存在 API Key，代理会添加 `Authorization: Bearer <key>`。

## HTTP API 使用

### GET /health

用于确认本地代理已经启动，并查看当前上游 API base。

```bash
curl -sS http://127.0.0.1:8402/health
```

示例响应：

```json
{
  "status": "ok",
  "baseUrl": "https://api.deepseek.com",
  "version": "0.1.0"
}
```

### POST /v1/chat/completions

这是本地 Router API 暴露给 OpenClaw 和普通 HTTP 客户端的版本化接口。它和实际的上游请求 URL 不是同一个概念；上游地址会根据运行时上游 API base 另行计算。

请求路径：

```text
POST http://127.0.0.1:8402/v1/chat/completions
```

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

显式使用 Flash：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      {
        "role": "user",
        "content": "Write a TypeScript function that sums numbers."
      }
    ]
  }'
```

显式使用 Pro：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [
      {
        "role": "user",
        "content": "Debug this failing Vitest suite across multiple files."
      }
    ]
  }'
```

流式请求：

```bash
curl -NS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Say hello in one short sentence."
      }
    ]
  }'
```

代理会透传上游响应体，包括 `text/event-stream`。流式响应同样会带路由响应头。

### 响应头说明

代理会添加 3 个响应头：

| 响应头                       | 含义                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `x-deepseek-router-model`    | 最终发送给上游的真实模型，值为 `deepseek-v4-flash` 或 `deepseek-v4-pro`。         |
| `x-deepseek-router-routed`   | 是否经过 `auto` 路由。请求模型为 `auto` 时通常为 `true`，显式模型请求为 `false`。 |
| `x-deepseek-router-fallback` | 是否发生 Flash 到 Pro 的回退。                                                    |

示例：

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

如果需要同时查看响应体和响应头，使用 `-i`：

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

### 错误处理

| 场景                          | HTTP 状态码 | 响应                                     |
| ----------------------------- | ----------: | ---------------------------------------- |
| JSON 解析失败                 |       `400` | `{"error":"Invalid JSON body"}`          |
| 请求体不是 JSON 对象          |       `400` | `{"error":"Body must be a JSON object"}` |
| 模型 ID 不支持                |       `400` | 错误信息包含支持的模型列表。             |
| 未实现路径，例如 `/v1/models` |       `404` | `{"error":"Not Found"}`                  |
| 上游网络错误                  |       `502` | `{"error":"<network error>"}`            |
| 代理内部未捕获错误            |       `502` | `{"error":"Bad Gateway","detail":"..."}` |

Flash 请求在遇到可重试上游状态码 `429`、`500`、`502`、`503`、`504` 时会尝试回退到 Pro。显式 Pro 请求不会降级。若最终仍是网络错误，返回 `502`，此类错误响应不保证包含路由响应头。

## OpenClaw 使用

### 安装插件

推荐从本地 npm 包安装：

```bash
cd /path/to/deepseek-router-mini
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install "./${PACKAGE_TGZ}" --force
```

如果 OpenClaw 安全扫描拦截安装，并且你确认正在安装本仓库刚构建的本地包，可以临时加上 `--dangerously-force-unsafe-install`。

如果你只是在本机开发，也可以安装源码目录：

```bash
openclaw plugins install /path/to/deepseek-router-mini --force
```

### 刷新 registry

安装或更新插件后刷新插件 registry：

```bash
openclaw plugins registry --refresh
openclaw plugins list --json
```

registry 刷新是冷启动视图修复路径，不等于把已经运行的 Gateway 进程热替换成新插件代码。

### 重启 Gateway

插件代码、启用状态、加载路径或 hook 策略变化后，重启提供服务的 Gateway：

```bash
openclaw gateway restart
openclaw gateway status
```

如果你在远程或容器中运行 OpenClaw，请确认重启的是实际承载 channel 的 Gateway 进程，而不是只重启了外层包装脚本。

### 确认 provider 和模型

```bash
openclaw plugins inspect deepseek-router-mini --json
openclaw plugins inspect deepseek-router-mini --runtime --json
openclaw models list
```

预期 provider：

```text
deepseek
```

预期模型：

```text
deepseek/auto
deepseek/deepseek-v4-flash
deepseek/deepseek-v4-pro
```

如需设置全局默认模型，可以使用当前 OpenClaw 版本提供的模型命令：

```bash
openclaw models set deepseek/auto
```

### 添加 agent

创建一个使用 `deepseek/auto` 的独立 agent：

```bash
openclaw agents add deepseek-router \
  --workspace ~/.openclaw/workspace-deepseek-router \
  --agent-dir ~/.openclaw/agents/deepseek-router \
  --model deepseek/auto \
  --non-interactive
```

查看 agent：

```bash
openclaw agents list --json
```

### agent 调用示例

默认 agent 调用：

```bash
openclaw agent \
  --agent deepseek-router \
  --session-id deepseek-router-agent-check \
  --message "Summarize briefly: OpenClaw routes simple tasks."
```

带会话 ID 调用：

```bash
openclaw agent \
  --agent deepseek-router \
  --session-id deepseek-router-check \
  --message "Debug a failing test across multiple files and explain the likely root cause."
```

OpenClaw agent CLI 通常只展示模型响应，不会直接展示代理响应头。如果要确认最终上游模型，请使用下一节的 HTTP 验证方法，或在上游侧查看请求中的 `model` 字段。

## 真实连通性验证

### 确认 8402 是 Gateway 拉起

独立代理和 OpenClaw 插件都可能监听 `8402`。运维时要先确认当前监听者是谁。

1. 重启 OpenClaw Gateway：

```bash
openclaw gateway restart
```

2. 检查端口：

```bash
lsof -nP -iTCP:8402 -sTCP:LISTEN
```

3. 检查健康接口：

```bash
curl -sS http://127.0.0.1:8402/health
```

4. 停止 Gateway 后再检查：

```bash
openclaw gateway stop
lsof -nP -iTCP:8402 -sTCP:LISTEN || true
```

这一步会短暂中断本机 OpenClaw Gateway，只建议在本地验证窗口执行。更温和的方式是对比 `openclaw gateway status` 输出的 Gateway PID 与 `lsof` 中监听 `8402` 的 PID；两者一致时，说明代理服务由 Gateway 进程拉起。

如果停止 Gateway 后 `8402` 不再监听，说明该代理大概率由 OpenClaw 插件 service 拉起。验证完成后重新启动：

```bash
openclaw gateway start
```

如果停止 Gateway 后 `8402` 仍在监听，通常是你手动运行的 `node dist/cli.js` 或其他进程占用了端口。用 `lsof` 输出中的 PID 定位进程。

### 确认 Flash 路由

使用简单任务验证 Flash：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: verify-flash' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Translate hello to Chinese."
      }
    ]
  }' | sed -n '1,40p'
```

预期响应头：

```text
x-deepseek-router-model: deepseek-v4-flash
x-deepseek-router-routed: true
x-deepseek-router-fallback: false
```

### 确认 Pro 路由

使用复杂任务验证 Pro：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: verify-pro' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Debug this failing test across multiple files and identify the root cause."
      }
    ]
  }' | sed -n '1,40p'
```

预期响应头：

```text
x-deepseek-router-model: deepseek-v4-pro
x-deepseek-router-routed: true
```

### 避免打印密钥

不要用 `set -x` 执行包含 API Key 的命令。不要把 `env`、`printenv`、完整 OpenClaw 配置或 shell 历史直接贴到聊天、issue、日志系统。

安全的检查方式：

```bash
test -n "${DEEPSEEK_API_KEY:-}" && printf 'DEEPSEEK_API_KEY is set\n'
```

如果必须检查长度：

```bash
printf 'DEEPSEEK_API_KEY length: %s\n' "${#DEEPSEEK_API_KEY}"
```

不要这样做：

```bash
echo "${DEEPSEEK_API_KEY}"
printenv DEEPSEEK_API_KEY
```

## 常见问题

### 端口占用

症状：

```text
DeepSeek Router Mini failed to start on port 8402: listen EADDRINUSE
```

排查：

```bash
lsof -nP -iTCP:8402 -sTCP:LISTEN
```

解决方式：

1. 如果是手动启动的旧代理，停止旧进程后重启。
2. 如果不能释放端口，改用新端口：

```bash
export DEEPSEEK_ROUTER_PORT="9011"
openclaw gateway restart
```

或在 OpenClaw 插件配置里设置：

```json
{
  "plugins": {
    "entries": {
      "deepseek-router-mini": {
        "enabled": true,
        "config": {
          "port": 9011
        }
      }
    }
  }
}
```

改端口后，插件会把 `models.providers.deepseek.baseUrl` 修复为 `http://127.0.0.1:9011/v1`。

### 401 或 403

常见原因：

- 没有配置 `DEEPSEEK_API_KEY`。
- OpenClaw provider 中没有 `apiKey` 或 `api_key`。
- 请求里自带了错误的 `Authorization`，覆盖了环境变量 API Key。
- `DEEPSEEK_ROUTER_HEADERS` 或 OpenClaw provider headers 配置了错误的 `Authorization`。
- 上游 `DEEPSEEK_BASE_URL` 指向了错误网关。

排查：

```bash
test -n "${DEEPSEEK_API_KEY:-}" && printf 'DEEPSEEK_API_KEY is set\n'
curl -sS http://127.0.0.1:8402/health
```

如需临时绕过 OpenClaw，直接用独立代理验证：

```bash
cd /path/to/deepseek-router-mini
export DEEPSEEK_API_KEY="sk-your-deepseek-api-key"
node dist/cli.js --port 9011
```

然后请求：

```bash
curl -iS http://127.0.0.1:9011/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [
      {
        "role": "user",
        "content": "hello"
      }
    ]
  }'
```

### provider already registered

OpenClaw 可能已经有内置或其他插件注册了 `deepseek` provider。插件遇到错误信息匹配 `provider already registered: deepseek` 时，会保留运行时代理 service，并注入或修复 `models.providers.deepseek` 配置。

这通常不是致命问题。你需要确认：

```bash
openclaw models list
openclaw plugins inspect deepseek-router-mini --json
curl -sS http://127.0.0.1:8402/health
```

如果模型仍未出现，刷新 registry 并重启：

```bash
openclaw plugins registry --refresh
openclaw gateway restart
```

### 没有 8402 监听

排查顺序：

```bash
openclaw plugins list --json
openclaw plugins inspect deepseek-router-mini --json
openclaw gateway status
openclaw gateway restart
lsof -nP -iTCP:8402 -sTCP:LISTEN || true
```

可能原因：

- 插件未安装或未启用。
- Gateway 没有重启，仍运行旧插件快照。
- 插件处于 discovery、cli-metadata、setup-only、tool-discovery 等只注册元数据的模式，运行时 service 没有启动。
- 插件配置了非默认端口。
- 端口启动失败，错误被记录在 Gateway 日志中。

查看 Gateway 日志：

```bash
openclaw gateway status
```

`openclaw gateway status` 通常会显示 Gateway 使用的日志文件路径。按该路径查看日志，比假设固定日志命令更稳妥。

### OpenClaw agent JSON 不显示最终上游模型

OpenClaw agent CLI 的 JSON 或文本输出通常来自模型响应体，不一定包含本代理添加的 HTTP 响应头。因此你可能看不到 `x-deepseek-router-model`。

确认最终模型的可靠方式：

- 用 `curl -i` 直接请求本地代理，查看响应头。
- 在兼容上游或网关日志中观察实际转发请求体里的 `model`。
- 为验证请求设置独立 `x-session-id`，避免会话钉住影响判断。

示例：

```bash
curl -iS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: route-check-fresh' \
  -d '{
    "model": "auto",
    "messages": [
      {
        "role": "user",
        "content": "Summarize this briefly."
      }
    ]
  }' | sed -n '1,40p'
```

### 流式响应

代理会把上游流式响应原样转发。验证方式：

```bash
curl -NS http://127.0.0.1:8402/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "auto",
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "hello"
      }
    ]
  }'
```

如果流式请求没有输出：

- 确认上游支持 Chat Completions 流式响应。
- 确认网络代理没有缓冲 SSE。
- 确认请求模型是支持的 3 个模型 ID 之一。
- 先用非流式请求确认 API Key 和上游地址正确。

## 安全建议

### API Key 管理

- 优先使用环境变量、OpenClaw 凭据管理或受控配置注入，不要把 Key 写入仓库。
- 不要把真实 Key 放入 `openclaw.plugin.json`，该文件是插件元数据，可能随包发布。
- 不要把真实 Key 写入 README、测试、截图或 issue。
- 轮换 Key 后要重启手动代理或 OpenClaw Gateway，确保运行时读取到新配置。

### Header 透传

代理会透传大部分请求头，但会过滤 hop-by-hop header，例如 `connection`、`keep-alive`、`transfer-encoding`、`host` 和 `content-length`。

需要注意：

- 自定义 header 会覆盖调用请求中的同名 header。
- 自定义 `Authorization` 会覆盖 `DEEPSEEK_API_KEY` 自动生成的 Bearer Token。
- `DEEPSEEK_ROUTER_HEADERS` 中所有值必须是字符串。
- OpenClaw provider 的 `request.headers` 会覆盖 provider 顶层 `headers` 中的同名字段。

### 日志脱敏

建议：

- 记录「Key 已配置」而不是记录 Key 内容。
- 打印 header 时主动删除或遮蔽 `Authorization`、`X-Api-Key`、`Cookie`。
- 排障时优先使用 `/health` 和路由响应头，避免输出完整环境变量。
- 共享 `curl -v` 输出前先检查是否包含 `Authorization`。

## 卸载与恢复

### 卸载 OpenClaw 插件

```bash
openclaw plugins uninstall deepseek-router-mini
openclaw plugins registry --refresh
openclaw gateway restart
```

确认插件消失：

```bash
openclaw plugins list --json
```

### 保留文件卸载

如果你只想从 OpenClaw 注册表移除插件，但保留本地文件：

```bash
openclaw plugins uninstall deepseek-router-mini --keep-files
openclaw plugins registry --refresh
openclaw gateway restart
```

### 恢复 OpenClaw provider 配置

卸载插件后，检查 OpenClaw 配置中的 `models.providers.deepseek`。如果该 provider 原本由其他 OpenClaw 机制管理，请恢复它的原始 `baseUrl`、`api`、`models` 和鉴权字段。

常见恢复方式：

```bash
openclaw models list
openclaw models set <your-previous-model-id>
openclaw gateway restart
```

如果当前 OpenClaw 版本没有全局默认模型，或你只为某个 agent 设置模型，请改为更新该 agent 的模型配置。

### 停止独立代理

如果是前台运行：

```bash
Ctrl-C
```

如果是后台进程，先定位 PID：

```bash
lsof -nP -iTCP:8402 -sTCP:LISTEN
```

确认 PID 属于你启动的 `node dist/cli.js` 后再停止：

```bash
kill <pid>
```

不要对不认识的进程使用强制停止。生产环境中应使用进程管理器或 Gateway 的生命周期命令停止服务。
