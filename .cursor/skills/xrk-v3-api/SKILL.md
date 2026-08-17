---
name: xrk-v3-api
description: 当你需要对接/调试 `/api/v3/chat/completions` 与 SSE 流式输出、multipart 多模态上传、workflow 工具白名单时使用。
---

## 实现

`core/system-Core/http/ai.js` + `core/system-Core/lib/ai-gateway-compat.js`

### OpenAI Chat Completions
- `POST /api/v3/chat/completions`（主路径）
- `POST /v1/chat/completions`
- `POST /openai/v1/chat/completions`
- `POST /api/v3/v1/chat/completions`（兼容 base=`/api/v3` 再拼 `/v1/...`）

### Models
- `GET /api/v3/models` · `GET /api/ai/models`
- `GET /v1/models` · `GET /openai/v1/models`
- `GET /api/v3/models/:modelId` · `GET /v1/models/:modelId` · `GET /openai/v1/models/:modelId`

### Anthropic Messages（Claude Code 原生）
- `POST /v1/messages`
- `POST /api/v3/messages` · `POST /api/v3/v1/messages`
- 请求转 OpenAI 形态后走同一套 chat 管线；非流式回 Anthropic message，流式写 Anthropic SSE

## 约定

- 入参/出参兼容 OpenAI Chat Completions（含 SSE `[DONE]`）。
- `model` = provider key。
- `workflow.workflows` → MCP 工具白名单。
- `multipart`：`messages` 为 JSON 字符串；`image/*` 转 base64 并入最后一条 user 消息。
- `/v1/*`、`/openai/v1/*` 显式 `systemAuth: 'ai.v1'`（非 `/api/` 前缀默认不挂鉴权）。

## Node 26

- 实现位于 `core/system-Core/http/ai.js`：出站 LLM 用全局 `fetch` + `buildFetchOptionsWithProxy`。
- multipart 图片编码用 `toBase64()`，勿 `toString('base64')`；超时用 `AbortSignal.timeout`。
- 完整 API 表：skill **`xrk-node-runtime`**。

## 排障

401 → `docs/AUTH.md`；无 provider → 端口下 `ai-workflow.yaml` / compat YAML；无工具 → `enableTools` 与 `streams` 白名单。
Claude Code：可直连 `ANTHROPIC_BASE_URL=http://host:port`（走 `/v1/messages`），`apiFormat=anthropic`，不必再依赖本地 openai_chat 翻译。
