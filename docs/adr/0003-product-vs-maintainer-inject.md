# ADR-0003: 产品 agents/ 注入 ≠ 根 AGENTS.md

- **Status:** Accepted
- **Date:** 2026-09-01
- **Tags:** inject, agents, skills

## 背景

本仓早已区分「写框架的 Coding Agent」与「办事助手产品 Agent」。根 `AGENTS.md` 若注入办事助手会污染人设与放码红线。Harness 用根 `AGENTS.md` vs `.agents/AGENTS.md` 表达同一纪律。

## 决策

1. **产品注入**：`agents/workspace/`、`agents/rules/`、工作区 `.xrk/skills/`、`subagents.yaml` —— 进入办事助手 prompt（见 [agent-context.md](../agent-context.md)）。
2. **维护者 / Coding**：根 `AGENTS.md`、`.cursor/skills/xrk-*` —— **不**进入办事助手链。
3. **Harness 桥**：共享工作区目录时，Harness 只读产品层；不得把 AGT 根 `AGENTS.md` 拷进 Harness workspace inject。

## 后果

- 与现有 `agent-context.md` §7 一致；本 ADR 仅固化不可逆约定。
- 状态表标记该分离为 **能跑**。

## 相关

[agents.md](../agents.md) · [agent-context.md](../agent-context.md)
