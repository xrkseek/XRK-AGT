---
name: xrk-project-overview
description: 当需要从整体理解 XRK-AGT 的架构、目录、运行流程和技术栈时使用。
---

## 文档

- 定位与分层：`docs/底层架构设计.md`（架构单一事实源）
- 启动链：`docs/startup.md`
- 目录树：`PROJECT_OVERVIEW.md`、`docs/README.md`
- **Node 26**：`docs/node-26-runtime.md`、skill **`xrk-node-runtime`**（写 Core 服务端必读）
- **Core www**：skill **`xrk-www-compat`**（浏览器兼容层 / 内联垫片）

## 要点

- **定位**：融合智能体业务逻辑的通用后端 — Runtime 在 `src/`，业务在 `core/`。
- 分层：AgentRuntime（Runtime）→ 基础设施（Loader/基类）→ Tasker / 事件 → Core 业务。
- 业务在 `core/<名>/(plugin|http|stream|tasker|events|commonconfig|www/<app>)`；`src/` 仅基础设施与工厂。
- 启动：见 `docs/startup.md`（`dist/app.js` → bootstrap → `dist/start.js` → `dist/src/agent-runtime.js`）。
- Node ≥ 26.0（`package.json` engines）；包管理仅 **pnpm**。

## Node 26

编码约定见 skill **`xrk-node-runtime`** 与 `docs/node-26-runtime.md`（本 skill 不重复禁止项表）。写 `www/` 见 **`xrk-www-compat`**。

## 放码速查

| 类型 | 路径 |
|------|------|
| 业务 | `core/<core>/` 各子目录 |
| 基类/加载器 | `src/infrastructure/` |
| 工具 | `src/utils/`（`bootstrap.js`、`process-signals.js`、`exec-async.js` 等） |
| 工厂 | `src/factory/` |
| 前端 | `core/<core>/www/<app>/` |
| 浏览器兼容 | `core/system-Core/www/xrk/modules/web-compat.js` |
