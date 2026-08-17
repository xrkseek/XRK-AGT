---
name: xrk-v3-api
description: 当你需要对接/调试标准 LLM 网关 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 与 SSE 时使用。
---

## 实现

- `core/system-Core/http/ai.js`：仅标准运营商路由
- `core/system-Core/lib/ai-gateway/`：协议转换

### 对外网关（仅这些）
- `POST /v1/chat/completions` · `/openai/v1/chat/completions`
- `GET /v1/models` · `/v1/models/:id`（及 `/openai/v1/...`）
- `POST /v1/messages`（Anthropic）
- `POST /v1/responses` · `/openai/v1/responses`
- `GET /v1/responses/:id` → 404（store=false）

**已移除**：`/api/v3/*`、`/api/ai/stream`。控制台 LLM 目录在 `ai-workspace`：`GET /api/ai/models`。

## 约定

- `model` = provider key；Chat SSE 含 `[DONE]`。
- Responses：不持久化；忽略 `previous_response_id`。
- `/v1/*`、`/openai/v1/*` 使用 `systemAuth: 'ai.v1'`。

## 排障

401 → `docs/AUTH.md`；无 provider → `ai-workflow.yaml`。
