# Xiaoyi Router 使用手册

本文面向两类读者：直接将 Xiaoyi Router 作为本地 OpenAI 兼容代理的用户，以及把它接入 OpenClaw Gateway 的运维者。文档中的命令均使用占位路径，请把 `/path/to/xiaoyi-router` 替换为你的实际项目目录，不要把真实 API Key 写入文档、脚本仓库或终端历史。

## 适用场景与能力边界

Xiaoyi Router 是一个轻量本地路由代理。它对本地 HTTP 客户端和 OpenClaw 暴露 `POST /v1/chat/completions`，再根据请求中的模型 ID 与提示词特征，把请求转发到 `upstreamBaseUrl + /chat/completions`。

本地 Router API 和上游 API base 是两层概念，必须分离：

- 本地 Router API：固定使用 `POST /v1/chat/completions`；`GET /health` 保留；`GET /v1/models` 当前未实现。
- OpenClaw Provider 的 `models.providers.xiaoyiprovider.baseUrl`：本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。
- 上游 API base：实际转发到 OpenAI 兼容上游时使用，优先级是 `pluginConfig.upstreamUrl` > `XIAOYI_BASE_URL` > `https://api.deepseek.com`。

实际上游请求 URL 按 `trimTrailingSlash(upstreamBaseUrl) + /chat/completions` 生成。上游 `baseUrl` 是否带 `/v1`、`/v4` 或不带版本，由用户配置决定；项目不自动追加版本段、不猜 provider、不根据域名分支。`upstreamUrl` 或 `XIAOYI_BASE_URL` 不要包含完整资源路径 `/chat/completions`。

适合使用的场景：

- 希望在本地暴露一个稳定的 OpenAI 兼容 Chat Completions 入口。
- 希望只向使用者暴露 `auto`、`deepseek-v4-flash`、`deepseek-v4-pro` 这 3 个模型 ID。
- 希望普通任务优先使用 Flash，复杂任务、调试任务、长上下文任务和真正需要工具的代码任务自动升级到 Pro。
- 希望把本地代理作为 OpenClaw 插件安装，写入或修复 `models.providers.xiaoyiprovider`，让标准 OpenAI 兼容 provider 配置指向本地代理。
- 希望用响应头观察一次请求最终路由到了 Flash 还是 Pro。

当前能力边界：

- 只实现 `GET /health` 和 `POST /v1/chat/completions`。
- 不实现 `GET /v1/models`，访问该路径会返回 `404`。
- 只接受 `auto`、`deepseek-v4-flash`、`deepseek-v4-pro`，其他模型 ID 会返回 `400`。
- 不缓存响应。响应缓存是后续候选能力，当前版本没有实现。
- 不管理真实上游 API Key。API Key 通过环境变量、OpenClaw provider 配置或请求头传入。
- 不自动切换监听端口。端口被占用时需要显式改端口并重启。
- 不改写 OpenClaw auth profile，也不创建 OpenClaw 专属鉴权向导。
- 不注册 `xiaoyiprovider` provider，也不在 `openclaw.plugin.json` 中声明 providers。

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
openclaw gateway restart
openclaw agents add <name> --workspace <dir> --agent-dir <dir> --model <model-id> --non-interactive
```

### 上游 API Key

独立代理模式通常使用 `XIAOYI_API_KEY`：

```bash
export XIAOYI_API_KEY="sk-your-upstream-api-key"
```

OpenClaw 插件模式推荐把真实 Key 写入 OpenClaw provider 配置：`models.providers.xiaoyiprovider.apiKey` 或 `models.providers.xiaoyiprovider.api_key`。这些字段会在 Gateway 重启和 router 修复配置时保留。默认 Gateway 通常不会读取当前源码目录下的 `.env`，因此不要把仓库 `.env` 当成 OpenClaw 运行时配置。环境变量只适合独立代理或明确配置过的 OpenClaw service env。不要在示例、日志或 issue 中粘贴真实 Key。

## 安装方式

### 源码安装

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
```

构建产物位于 `dist/`。CLI 入口为 `dist/cli.js`，包导出的 OpenClaw 插件入口为 `dist/index.js`。

### 本地开发构建

开发时可以使用 watch 模式：

```bash
cd /path/to/xiaoyi-router
npm run dev
```

运行正式验证或打包前仍建议执行一次普通构建：

```bash
npm run build
```

### npm pack

项目的 `package.json` 会把 `dist`、`README.md`、`openclaw.plugin.json` 纳入发布文件。打本地包前先构建：

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
printf '%s\n' "${PACKAGE_TGZ}"
```

输出类似：

```text
xiaoyi-router-0.1.0.tgz
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

从源码目录打包安装本地包。端到端验证建议使用 npm 包安装，不建议用源码目录安装或 `link` 安装，以免被旧版本或本地软链污染。

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install --dangerously-force-unsafe-install --force "./${PACKAGE_TGZ}"
openclaw gateway restart
```

`--dangerously-force-unsafe-install` 只应在确认包来自当前源码构建时使用。验证完成后可以删除本地生成的 tarball：

```bash
rm -f "./${PACKAGE_TGZ}"
```

安装后确认插件可见：

```bash
openclaw plugins list --json
openclaw plugins inspect xiaoyi-router --json
```

确认 provider 配置已经注入：

```bash
openclaw config get models.providers.xiaoyiprovider
```

## 快速开始

### 独立代理模式

独立代理模式不依赖 OpenClaw，适合先确认代理本身可以工作。

1. 构建项目：

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
```

2. 启动本地代理：

```bash
export XIAOYI_API_KEY="sk-your-upstream-api-key"
node dist/cli.js
```

默认监听地址为：

```text
http://127.0.0.1:8402
```

启动成功时终端会输出：

```text
xiaoyi-router listening on http://127.0.0.1:8402
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
x-xiaoyi-router-model: deepseek-v4-flash
x-xiaoyi-router-tier: MEDIUM
x-xiaoyi-router-trace: auto:medium:flash:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-fallback: false
```

### OpenClaw 插件模式

OpenClaw 插件模式不会注册 `xiaoyiprovider` provider，也不会在 manifest 中声明 providers。它会写入或修复 `models.providers.xiaoyiprovider`，把 `baseUrl` 指向本地 Router API，把 `api` 设置为 `openai-completions`，并同步 `auto`、`deepseek-v4-flash`、`deepseek-v4-pro` 这 3 个模型定义。

`xy_channel` 是可选组件。安装 `xy_channel` 时，可以由它负责 provider 实现和注册；未安装时，Xiaoyi Router 仍可作为标准 OpenAI 兼容 provider 配置下的本地路由服务使用。

1. 从源码打包并安装到默认 OpenClaw Gateway：

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install --dangerously-force-unsafe-install --force "./${PACKAGE_TGZ}"
openclaw gateway restart
```

2. 配置 OpenClaw provider Key：

```bash
openclaw config set models.providers.xiaoyiprovider.apiKey "$XIAOYI_API_KEY"
openclaw gateway restart
```

3. 确认 Gateway、插件和 provider：

```bash
openclaw gateway status
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
```

`models.providers.xiaoyiprovider` 应指向本地代理：

```text
baseUrl: http://127.0.0.1:8402/v1
api: openai-completions
```

模型列表应包含：

```text
auto
deepseek-v4-flash
deepseek-v4-pro
```

不同 OpenClaw 版本对 `openclaw models list` 的展示不完全一致。排查安装结果时，以 `openclaw config get models.providers.xiaoyiprovider` 和真实请求验证为准。

4. 创建一个使用 `xiaoyiprovider/auto` 的临时 agent：

```bash
tmpbase="$(mktemp -d /tmp/xiaoyi-openclaw-agent.XXXXXX)"
openclaw agents add xiaoyi-router \
  --workspace "$tmpbase/workspace" \
  --agent-dir "$tmpbase/agent" \
  --model xiaoyiprovider/auto \
  --non-interactive
```

5. 发起一次 agent 调用：

```bash
openclaw agent \
  --agent xiaoyi-router \
  --message "Return exactly: XIAOYI_E2E_OK" \
  --json \
  --timeout 180
```

6. 验证结束后清理临时 agent、临时目录和 tarball：

```bash
openclaw agents delete xiaoyi-router --force --json
rm -rf "$tmpbase" "./${PACKAGE_TGZ}"
```

完整排障流程见后文「OpenClaw 使用」和「真实连通性验证」。

## 模型说明

本项目公开 3 个模型 ID：

| 模型 ID             | 类型         | 上游实际模型          | 场景                                                 |
| ------------------- | ------------ | --------------------- | ---------------------------------------------------- |
| `auto`              | 路由模型     | 自动选择 Flash 或 Pro | 推荐给 OpenClaw 和普通使用者，按任务自动路由。       |
| `deepseek-v4-flash` | 真实上游模型 | `deepseek-v4-flash`   | 简单任务、标准问答、普通代码生成、成本敏感调用。     |
| `deepseek-v4-pro`   | 真实上游模型 | `deepseek-v4-pro`     | 调试、架构、重构、多文件、长上下文、工具型代码编辑。 |

模型元数据来自源码中的 `XIAOYI_MODELS`：

| 模型 ID             | 上下文窗口 | 最大输出 | Reasoning | Tool calling | 输入价格元数据 | 输出价格元数据 |
| ------------------- | ---------: | -------: | --------- | ------------ | -------------: | -------------: |
| `auto`              |    1000000 |    64000 | 是        | 是           |              0 |              0 |
| `deepseek-v4-flash` |    1000000 |    64000 | 是        | 是           |           0.28 |           0.42 |
| `deepseek-v4-pro`   |    1000000 |    64000 | 是        | 是           |           0.56 |           1.68 |

价格字段是项目暴露给 OpenClaw 的模型元数据，不等同于供应商实时账单承诺。生产计费以上游服务商为准。

## 自动路由说明

只有请求模型为 `auto` 时才会执行自动路由。当前默认策略是 Flash 优先：简单摘要、短文本、常规问答、普通代码改动、轻量 agentic 任务和常规结构化输出默认使用 `deepseek-v4-flash`；复杂推理、自然多文件调试或修复流程默认使用 `deepseek-v4-pro`。长上下文会参与评分，但不会仅因超过固定 token 阈值而直接强制切到 Pro。路由审计样本会把 Flash 占比钉在 80% 到 90% 之间，后续调整比例时优先改规则配置和审计样本。

显式模型优先于自动路由。显式请求 `deepseek-v4-flash` 时固定使用 Flash；显式请求 `deepseek-v4-pro` 时固定使用 Pro。显式请求会把 `x-xiaoyi-router-routed` 设为 `false`。

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

简单 agentic 或轻量文件操作默认仍路由到 Flash。例如：

```text
Open the README, update the typo, and verify the sentence reads naturally.
```

如果请求同时具有代码库范围、失败诊断和明确执行意图，例如跨多个文件排查测试失败、定位回归并修复验证，则路由到 Pro。典型场景：

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
      "content": "Inspect the auth and session files, explain why the integration suite started failing, patch it, and verify the fix."
    }
  ]
}
```

### 复杂任务

包含复杂推理、架构分析、跨文件调试、测试失败回归、根因定位、修复并验证等特征时，路由到 Pro。复杂规则优先级高于简单规则和代码规则。例如：

```text
Inspect the auth and session files, trace the regression, and tell me why the integration suite is failing.
```

如果只是解释、改写、总结或列出一句包含调试词的文本，不会因为这些词面内容被误判为复杂调试。

### 长上下文

长上下文会作为评分和能力信号参与路由判断，但当前没有“达到多少 estimated tokens 就直接升 Pro”的硬阈值。估算方式仍是系统提示词与路由文本拼接后的字符数除以 4 并向上取整，即 `Math.ceil(fullText.length / 4)`；只是这个估算值现在只参与整体评分，而不单独决定最终模型。

### 工具与 OpenClaw bootstrap 场景

OpenClaw agent 经常会在请求中附带工具列表，或者在消息里包含 bootstrap 内容。代理有两条保护逻辑：

- 只有「代码任务 + 实际带工具」才因为工具升级到 Pro。简单总结、翻译等请求即使带着环境工具，也保持在 Flash。
- 对 OpenClaw CLI 风格的多轮包装消息，代理会优先使用最后一个用户回合做路由判断，避免被前面的 bootstrap 文本误导。

示例：即使请求体带有 `apply_patch` 工具，只要最终用户任务是简短总结，也会路由到 Flash。

### 会话钉住

`auto` 请求默认开启会话钉住（session pinning）。代理会根据请求头 `x-session-id` 或首段消息内容派生会话 ID。当某个会话成功路由到 Pro 后，同一会话后续 `auto` 请求会继续使用 Pro，避免一段复杂会话在 Flash 和 Pro 之间来回跳动。Flash 请求不会建立可复用 pin，后续仍会重新路由。

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
| `XIAOYI_API_KEY`        | 可选上游 API Key。合并后没有 `Authorization` 时，代理会补充 `Authorization: Bearer <apiKey>`；未配置时不发送 `Authorization`。 | 无                         |
| `XIAOYI_BASE_URL`       | 上游 API base。代理会去掉末尾多余 `/`，再追加 `/chat/completions`。                     | `https://api.deepseek.com` |
| `XIAOYI_ROUTER_PORT`    | 本地监听端口。必须是 `1` 到 `65535` 之间的整数。                                        | `8402`                     |
| `XIAOYI_ROUTER_HEADERS` | 额外上游请求头，JSON 对象，值必须是字符串。                                             | `{}`                       |
| `XIAOYI_ROUTER_TRACE`   | 路由诊断日志模式。可选 `summary` 或 `debug`；其他值按关闭处理。                         | 关闭                       |

示例：

```bash
export XIAOYI_API_KEY="sk-your-upstream-api-key"
export XIAOYI_BASE_URL="https://api.deepseek.com"
export XIAOYI_ROUTER_PORT="8402"
export XIAOYI_ROUTER_HEADERS='{"X-Request-Source":"xiaoyi-router"}'
export XIAOYI_ROUTER_TRACE="summary"
node dist/cli.js
```

上游 API base 示例：

| `upstreamBaseUrl`                | 实际上游请求 URL                                  |
| -------------------------------- | ------------------------------------------------- |
| `https://api.deepseek.com`       | `https://api.deepseek.com/chat/completions`       |
| `https://gateway.example.com/v1` | `https://gateway.example.com/v1/chat/completions` |
| `https://gateway.example.com/v4` | `https://gateway.example.com/v4/chat/completions` |

`XIAOYI_ROUTER_HEADERS` 必须是 JSON 对象，且每个 header 值必须是字符串。以下写法会在解析配置时抛错：

```bash
export XIAOYI_ROUTER_HEADERS='["not", "object"]'
export XIAOYI_ROUTER_HEADERS='{"X-Test":123}'
```

`XIAOYI_ROUTER_TRACE` 默认关闭，不会增加 OpenClaw Gateway 日志量。需要排查路由时可以临时打开：

```bash
XIAOYI_ROUTER_TRACE=summary node dist/cli.js
```

`summary` 每次请求只输出一行紧凑摘要，例如：

```text
[xiaoyi-router] auto:agentic:pro:first-pass model=deepseek-v4-pro fallback=false
```

`debug` 输出结构化 JSON，包含最终模型、tier、profile、session 动作、单次上游尝试和 prompt preview。prompt preview 只保留路由文本的前 10 个字符和后 10 个字符，中间用 `...` 省略；不会记录完整 prompt、system prompt、messages、Authorization、Cookie 或上游自定义 headers。

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
| `--base-url <url>` | 覆盖 OpenAI 兼容上游 API base。 |

CLI 参数优先于环境变量中的同类配置。

### OpenClaw pluginConfig

`openclaw.plugin.json` 定义了两个插件配置项：

```json
{
  "port": 8402,
  "upstreamUrl": "https://api.deepseek.com"
}
```

在 OpenClaw 配置中，插件配置通常位于 `plugins.entries.xiaoyi-router.config`。示例：

```json
{
  "plugins": {
    "entries": {
      "xiaoyi-router": {
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
2. `XIAOYI_ROUTER_PORT`、`XIAOYI_BASE_URL`
3. 默认值 `8402`、`https://api.deepseek.com`

### OpenClaw provider 配置

插件加载时会写入或修复：

```jsonc
{
  "models": {
    "providers": {
      "xiaoyiprovider": {
        "baseUrl": "http://127.0.0.1:8402/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "auto",
            "name": "Xiaoyi Auto",
            "api": "openai-completions",
            "reasoning": true,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1000000,
            "maxTokens": 64000
          }
          // deepseek-v4-flash 和 deepseek-v4-pro 的完整模型定义同样会写入，此处省略。
        ]
      }
    }
  }
}
```

注意：

- `models.providers.xiaoyiprovider.baseUrl` 是本地代理地址，必须是 `http://127.0.0.1:<port>/v1`。
- OpenClaw 的 `openai-completions` 适配器会在该 `baseUrl` 后追加 `/chat/completions`，最终落到本插件的 `POST /v1/chat/completions`。
- `upstreamUrl` 或 `XIAOYI_BASE_URL` 是真实 OpenAI 兼容上游 API base，不带 `/chat/completions`。
- 实际转发到上游时，绝不能使用 OpenClaw Provider 的 `baseUrl`；只能使用插件运行时上游 API base。
- 插件会保留已有的 `apiKey`、`api_key`、`headers`、`request` 和未知字段，只修复 `baseUrl`、`api` 和 `models` 等托管字段。
- 如果 `apiKey` 不存在，插件不会凭空创建真实 Key；新建 provider 配置时该字段保持缺省语义。
- 该配置可以配合 `xy_channel` 提供的 provider 实现使用；未安装 `xy_channel` 时，也可以作为标准 OpenAI 兼容 provider 配置指向本地 router。

插件启动代理时会读取下列 provider 字段作为运行时覆盖：

```json
{
  "models": {
    "providers": {
      "xiaoyiprovider": {
        "apiKey": "sk-your-upstream-api-key",
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
      "xiaoyiprovider": {
        "api_key": "sk-your-upstream-api-key"
      }
    }
  }
}
```

header 合并规则：

- `models.providers.xiaoyiprovider.headers` 会传给代理，可用于透传 `x-uid`。
- `models.providers.xiaoyiprovider.request.headers` 会传给代理，可用于透传 `x-uid`，并覆盖同名 provider header。
- 非字符串 header 值会被忽略。
- 这些 header 会覆盖调用请求中的同名 header。
- `apiKey` 可选：提供时，如果最终 header 中没有 `Authorization`，代理会添加 `Authorization: Bearer <apiKey>`；不提供时不发送 `Authorization`。
- 如果请求或配置中已经有 `Authorization`，遵循当前实现的 header 合并语义，不再用 `apiKey` 覆盖。

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

代理会添加下列响应头：

| 响应头                       | 含义                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `x-xiaoyi-router-model`    | 最终发送给上游的真实模型，值为 `deepseek-v4-flash` 或 `deepseek-v4-pro`。         |
| `x-xiaoyi-router-tier`     | 本次路由判定的复杂度层级，值为 `SIMPLE`、`MEDIUM`、`COMPLEX` 或 `REASONING`。     |
| `x-xiaoyi-router-trace`    | 紧凑路由摘要，格式类似 `auto:medium:flash:first-pass`。                           |
| `x-xiaoyi-router-routed`   | 是否经过 `auto` 路由。请求模型为 `auto` 时通常为 `true`，显式模型请求为 `false`。 |
| `x-xiaoyi-router-fallback` | 是否发生备用模型切换。当前实现固定为 `false`。                                     |
| `x-xiaoyi-router-upstream` | 当前代理配置的真实上游 API base。                                                  |

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

当前代理不会在 Flash 和 Pro 之间自动切换。上游返回 `429`、`500`、`502`、`503`、`504` 时，代理直接透传该失败响应；网络错误返回 `502`。此类错误响应仍尽量附带路由响应头，便于确认本次原本选中的模型。

## OpenClaw 使用

这一节描述从源码打包、安装到 OpenClaw 默认 Gateway、配置 provider、验证请求和清理临时文件的完整流程。端到端验证时只使用当前 OpenClaw 默认 Gateway，不创建临时 OpenClaw profile，不额外启动第二个 Gateway。

### 1. 清理旧插件占用

如果本机之前安装过旧插件，可能已经占用 `8402`。先查看当前状态：

```bash
openclaw plugins list --json
lsof -nP -iTCP:8402 -sTCP:LISTEN || true
```

如果列表里存在旧的 `deepseek-router-mini` 插件，先卸载后重启默认 Gateway：

```bash
openclaw plugins uninstall deepseek-router-mini || true
openclaw gateway restart
```

如果 `8402` 仍被非 OpenClaw 进程占用，请先停止该进程，或按「端口占用」小节改插件端口。

### 2. 从源码打包安装

推荐使用 tarball 安装，不建议用源码目录或 link 安装做端到端验证：

```bash
cd /path/to/xiaoyi-router
npm install
npm run build
PACKAGE_TGZ="$(npm pack --silent)"
openclaw plugins install --dangerously-force-unsafe-install --force "./${PACKAGE_TGZ}"
```

`--dangerously-force-unsafe-install` 只用于安装当前源码刚构建出来的本地包。不要用它安装来源不明的包。

安装后重启默认 Gateway：

```bash
openclaw gateway restart
openclaw gateway status
```

如果 OpenClaw 的插件列表视图没有刷新，可以补充执行：

```bash
openclaw plugins registry --refresh
```

registry 刷新只影响 OpenClaw 的插件发现视图，不等于热替换正在运行的 Gateway 进程。插件代码、启用状态或服务配置变化后，仍以 `openclaw gateway restart` 为准。

### 3. 配置 provider

插件会写入或修复 `models.providers.xiaoyiprovider`，但不会注册 provider。先确认配置存在：

```bash
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
```

预期关键字段：

```text
baseUrl: http://127.0.0.1:8402/v1
api: openai-completions
```

模型配置中应包含：

```text
auto
deepseek-v4-flash
deepseek-v4-pro
```

不同 OpenClaw 版本对 `openclaw models list` 的展示不完全一致；如果模型列表没有展示插件模型，但 `openclaw config get models.providers.xiaoyiprovider` 正确，后续请求验证仍是更可靠的判断。

配置真实上游 Key：

```bash
openclaw config set models.providers.xiaoyiprovider.apiKey "$XIAOYI_API_KEY"
openclaw gateway restart
```

如果需要透传 `x-uid` 或其它自定义 Header，推荐放在 provider 的 `request.headers`：

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

`apiKey` 是可选项。用户请求自带 `Authorization` 时会按请求 Header 转发；没有 `Authorization` 但 provider 配置了 `apiKey` 时，代理会补上 `Authorization: Bearer <apiKey>`；两者都没有时，代理不会强制鉴权。

### 4. 验证本地代理

先确认默认 Gateway 已经拉起插件代理：

```bash
curl -sS http://127.0.0.1:8402/health
```

预期返回包含：

```json
{
  "status": "ok",
  "baseUrl": "https://api.deepseek.com"
}
```

再用显式模型做一次真实 Chat Completions 验证：

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
x-xiaoyi-router-tier: MEDIUM
x-xiaoyi-router-trace: explicit:medium:flash:user
x-xiaoyi-router-routed: false
x-xiaoyi-router-fallback: false
x-xiaoyi-router-upstream: https://api.deepseek.com
```

### 5. 验证 OpenClaw agent

创建一个临时 agent，模型使用 `xiaoyiprovider/auto`：

```bash
tmpbase="$(mktemp -d /tmp/xiaoyi-openclaw-agent.XXXXXX)"
openclaw agents add xiaoyi-e2e-agent \
  --workspace "$tmpbase/workspace" \
  --agent-dir "$tmpbase/agent" \
  --model xiaoyiprovider/auto \
  --non-interactive \
  --json
```

执行一次端到端调用：

```bash
openclaw agent \
  --agent xiaoyi-e2e-agent \
  --message "Return exactly: XIAOYI_E2E_OK" \
  --json \
  --timeout 180
```

预期 JSON 中 `status` 为 `ok`，响应文本包含 `XIAOYI_E2E_OK`，并且 agent 元数据里使用 `xiaoyiprovider/auto`。

OpenClaw agent CLI 通常只展示 OpenClaw 侧 provider 和模型，不一定暴露代理响应头。确认最终走 Flash 还是 Pro 的首选方式仍是下一节的 HTTP 响应头验证；如果需要从 Gateway 日志侧排查，可以临时设置 `XIAOYI_ROUTER_TRACE=summary` 或 `XIAOYI_ROUTER_TRACE=debug`。默认不记录逐次路由日志，避免增加 OpenClaw logs 负担。

验证结束后清理临时 agent 和目录：

```bash
openclaw agents delete xiaoyi-e2e-agent --force --json
rm -rf "$tmpbase"
```

### 6. 验证自动路由

简单任务应路由到 Flash：

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
x-xiaoyi-router-model: deepseek-v4-flash
x-xiaoyi-router-tier: MEDIUM
x-xiaoyi-router-trace: auto:medium:flash:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-fallback: false
x-xiaoyi-router-upstream: https://api.deepseek.com
```

复杂任务应路由到 Pro：

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
x-xiaoyi-router-model: deepseek-v4-pro
x-xiaoyi-router-tier: COMPLEX
x-xiaoyi-router-trace: auto:agentic:pro:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-upstream: https://api.deepseek.com
```

验证自动路由时建议每次使用新的 `x-session-id`，避免 session pin 影响判断。

### 7. 清理本地临时产物

验证完成后删除打包产物和临时输出：

```bash
rm -f "./${PACKAGE_TGZ}"
rm -rf /tmp/xiaoyi-openclaw-agent.*
```

不要把真实 Key、完整 OpenClaw 配置、`env` 或 `printenv` 输出提交到仓库或粘贴到 issue。

## 真实连通性验证

如果你只需要快速复核路由头，可以在完成 OpenClaw 安装和 provider 配置后直接执行下面两组请求。

### 确认 Flash 路由

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
x-xiaoyi-router-model: deepseek-v4-flash
x-xiaoyi-router-tier: MEDIUM
x-xiaoyi-router-trace: auto:medium:flash:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-fallback: false
x-xiaoyi-router-upstream: https://api.deepseek.com
```

### 确认 Pro 路由

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
x-xiaoyi-router-model: deepseek-v4-pro
x-xiaoyi-router-tier: COMPLEX
x-xiaoyi-router-trace: auto:agentic:pro:first-pass
x-xiaoyi-router-routed: true
x-xiaoyi-router-upstream: https://api.deepseek.com
```

### 使用 Python 中转观测实际模型

仓库提供了一个本地调试脚本 [scripts/deepseek_openai_proxy.py](/Users/ming/Documents/Code/2026/ai_repos/deepseek-router-mini/scripts/deepseek_openai_proxy.py)，用于验证「项目模型 ID 改名后，路由仍能正确转发到实际 DeepSeek 模型」。它暴露 OpenAI 兼容接口，并把每次请求的别名模型和实际上游模型打印到终端。

脚本内置映射：

| 本地验证模型 ID             | 实际上游模型          |
| --------------------------- | --------------------- |
| `LLM_DeepSeekV4_Think0`     | `deepseek-v4-flash`   |
| `LLM_DeepSeekV4_Pro_Think0` | `deepseek-v4-pro`     |

启动脚本：

```bash
cd /path/to/xiaoyi-router
export XIAOYI_API_KEY="sk-your-upstream-api-key"
python3 scripts/deepseek_openai_proxy.py --port 19081
```

健康检查：

```bash
curl -sS http://127.0.0.1:19081/health
```

如果要验证模型 ID 是否集中维护，可以在本地临时把 `src/models.ts` 中的模型注册表改成：

```text
light: LLM_DeepSeekV4_Think0
strong: LLM_DeepSeekV4_Pro_Think0
```

这一步只用于本地实验，不建议提交。验证结束后恢复 `src/models.ts`。

然后把 OpenClaw 插件上游指向 Python 中转：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.upstreamUrl "http://127.0.0.1:19081/v1"
openclaw gateway restart
```

重新从源码打包安装当前分支，再用 `curl -i http://127.0.0.1:8402/v1/chat/completions` 或 `openclaw agent` 验证。Python 终端中应出现类似日志：

```text
[deepseek-openai-proxy] event=chat model=LLM_DeepSeekV4_Think0 upstream_model=deepseek-v4-flash status=200 duration_ms=1234
[deepseek-openai-proxy] event=chat model=LLM_DeepSeekV4_Pro_Think0 upstream_model=deepseek-v4-pro status=200 duration_ms=2345
```

验证完成后恢复 OpenClaw 插件上游：

```bash
openclaw config set plugins.entries.xiaoyi-router.config.upstreamUrl "https://api.deepseek.com"
openclaw gateway restart
```

### 避免打印密钥

不要用 `set -x` 执行包含 API Key 的命令。不要把 `env`、`printenv`、完整 OpenClaw 配置或 shell 历史直接贴到聊天、issue、日志系统。

安全的检查方式：

```bash
test -n "${XIAOYI_API_KEY:-}" && printf 'XIAOYI_API_KEY is set\n'
```

如果必须检查长度：

```bash
printf 'XIAOYI_API_KEY length: %s\n' "${#XIAOYI_API_KEY}"
```

不要这样做：

```bash
echo "${XIAOYI_API_KEY}"
printenv XIAOYI_API_KEY
```

## 常见问题

### 端口占用

症状：

```text
Xiaoyi Router failed to start on port 8402: listen EADDRINUSE
```

排查：

```bash
lsof -nP -iTCP:8402 -sTCP:LISTEN
```

解决方式：

1. 如果是手动启动的旧代理，停止旧进程后重启。
2. 如果不能释放端口，改用新端口：

```bash
export XIAOYI_ROUTER_PORT="9011"
openclaw gateway restart
```

或在 OpenClaw 插件配置里设置：

```json
{
  "plugins": {
    "entries": {
      "xiaoyi-router": {
        "enabled": true,
        "config": {
          "port": 9011
        }
      }
    }
  }
}
```

改端口后，插件会把 `models.providers.xiaoyiprovider.baseUrl` 修复为 `http://127.0.0.1:9011/v1`。

### 401 或 403

常见原因：

- OpenClaw provider 中没有 `apiKey` 或 `api_key`。
- 只在源码目录 `.env` 里配置了 `XIAOYI_API_KEY`，但默认 OpenClaw Gateway 没有读取该文件。
- 请求里自带了错误的 `Authorization`，覆盖了环境变量 API Key。
- `XIAOYI_ROUTER_HEADERS` 或 OpenClaw provider headers 配置了错误的 `Authorization`。
- 上游 `XIAOYI_BASE_URL` 指向了错误网关。

排查：

```bash
openclaw config get models.providers.xiaoyiprovider.apiKey
openclaw config get models.providers.xiaoyiprovider
curl -sS http://127.0.0.1:8402/health
```

如果 `apiKey` 为空，使用当前 shell 中的真实 Key 写入 OpenClaw provider 后重启 Gateway：

```bash
openclaw config set models.providers.xiaoyiprovider.apiKey "$XIAOYI_API_KEY"
openclaw gateway restart
```

如需临时绕过 OpenClaw，直接用独立代理验证：

```bash
cd /path/to/xiaoyi-router
export XIAOYI_API_KEY="sk-your-upstream-api-key"
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

### provider 不可用

如果 OpenClaw 提示 `xiaoyiprovider` 不可用，先确认当前环境由谁提供 provider 实现。安装了 `xy_channel` 时，可以由 `xy_channel` 负责 provider 实现和注册；未安装时，请确认 OpenClaw 支持从 `models.providers.xiaoyiprovider` 这类标准 OpenAI 兼容 provider 配置发起请求。

排查时先确认 router 配置和本地服务：

```bash
openclaw plugins inspect xiaoyi-router --json
openclaw config get models.providers.xiaoyiprovider
curl -sS http://127.0.0.1:8402/health
```

如果 provider 配置没有修复，刷新 registry 并重启 Gateway：

```bash
openclaw plugins registry --refresh
openclaw gateway restart
```

### 没有 8402 监听

排查顺序：

```bash
openclaw plugins list --json
openclaw plugins inspect xiaoyi-router --json
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

OpenClaw agent CLI 的 JSON 或文本输出通常来自模型响应体，不一定包含本代理添加的 HTTP 响应头。因此你可能看不到 `x-xiaoyi-router-model`。

确认最终模型的可靠方式：

- 用 `curl -i` 直接请求本地代理，查看响应头。
- 如果上游或外层网关会记录请求体，在上游侧观察实际转发请求里的 `model`。
- 为验证请求设置独立 `x-session-id`，避免会话钉住影响判断。

默认情况下，Gateway 日志只能稳定看到插件生命周期信息，例如配置修复、代理监听地址、端口启动失败等。每次请求的 `x-xiaoyi-router-model`、`x-xiaoyi-router-tier`、`x-xiaoyi-router-trace`、`x-xiaoyi-router-routed` 和 `x-xiaoyi-router-fallback` 仍以 HTTP 响应头为准。需要日志侧诊断时再打开 `XIAOYI_ROUTER_TRACE`。

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
- 自定义 `Authorization` 会覆盖 `XIAOYI_API_KEY` 自动生成的 Bearer Token；未提供 `apiKey` 时，代理不会主动发送 `Authorization`。
- `x-uid` 可通过 provider `headers` 或 `request.headers` 透传。
- `XIAOYI_ROUTER_HEADERS` 中所有值必须是字符串。
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
openclaw plugins uninstall xiaoyi-router
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
openclaw plugins uninstall xiaoyi-router --keep-files
openclaw plugins registry --refresh
openclaw gateway restart
```

### 恢复 OpenClaw 配置

卸载插件后，检查 OpenClaw 配置中的 `models.providers.xiaoyiprovider`。如果这段配置原本由其他 OpenClaw 机制管理，请恢复它的原始 `baseUrl`、`api`、`models` 和鉴权字段。

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
