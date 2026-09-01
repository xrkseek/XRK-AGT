---
name: xrk-llm
description: 当你需要配置/新增/排查 LLM 提供商（OpenAI/Azure/Gemini/Anthropic/Ollama/各类兼容网关）时使用；确保 YAML/Schema/代码一致。
---

> **读者：Coding Agent**（工厂与配置三同步）。办事助手勿读本文件。

## 入口

`docs/factory.md`、`src/factory/llm/LLMFactory.js`、`core/system-Core/http/ai.js`、`docs/harness-module-loop.md`

## 外仓吸收三准则（必须同时满足）

1. **本项目没有**（无等价能力，不是「差一点」）
2. **本产品有必要**（QQ/多通道 AgentRuntime 真刚需，不是酷炫）
3. **对方做得明显更好**（可移植且更稳/更对）

不满足则不学、不融。

## 出站 / tool 环

```
slash/recipe → messages → contextWindow trim → harness continueTurn（MCP）
无 MCP 的 /v1 · 流式单次 → LLMFactory chat/chatStream（不执行工具）
```

并行：`policies` + `security.toolScan`（`approval` 默认关）+ SystemContext 指纹。

群聊入口：`plugin/ai.js` → `ChatStream.process({ mergeWorkflows })`；见 `docs/agent-context.md`。

## 已吸收（过三准则）

| 能力 | 来源 | 落点 |
|------|------|------|
| Agent loop / session 压缩 | XRK-Harness | `@xrkseek/harness` · `harness-module-loop` |
| Policy + 威胁扫描 + 可选审批 | opencode/goose | `runtime-policy` · `security.*` |
| Recipe / slash | goose | `recipes/` · `slash-commands` |
| apply_edit / verify / PageRank map | aider | tools MCP |
| triggers microagents | OpenHands | `trigger-microagents` |
| aux / variants / reasoning budget / 重试 | goose/cline/opencode | 既有 LLM 工厂（单次补全） |
