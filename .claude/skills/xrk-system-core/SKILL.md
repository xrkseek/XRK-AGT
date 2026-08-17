---
name: xrk-system-core
description: 当你需要快速理解 system-Core 提供哪些 HTTP API/工作流/插件/Tasker/Web 控制台能力，或定位某个模块在哪实现时使用。
---

## 权威文档

- `docs/system-core.md`

## system-Core 的关键目录

- HTTP：`core/system-Core/http/*.js`
- Workflow：`core/system-Core/workflow/*.js`（`#infrastructure/crawl`→`web.js` / `browser.js`；详见 skill `xrk-crawl`）
- Plugin：`core/system-Core/plugin/*.js`
- Tasker：`core/system-Core/tasker/*.js`
- Events：`core/system-Core/events/*.js`（`onebot` / `device` / `stdin` / `opqbot` / `gsuidcore`…）
- CommonConfig（前端表单 Schema）：`core/system-Core/commonconfig/*.js`
- Web 控制台：`core/system-Core/www/xrk/*` → `/xrk`
- 浏览器兼容：`core/system-Core/www/xrk/modules/web-compat.js`（skill **`xrk-www-compat`**）

## Node 26

扩展 system-Core **服务端**时遵守 skill **`xrk-node-runtime`**。改 `www/` 时遵守 **`xrk-www-compat`**（浏览器兼容层）。

## 常用定位

- AI / 对话 API：`core/system-Core/http/ai.js`
- 配置管理 API：`core/system-Core/http/config.js`
- MCP API：`core/system-Core/http/mcp.js`
- 控制台入口：`core/system-Core/www/xrk/`
- 浏览器兼容层：`core/system-Core/www/xrk/modules/web-compat.js`
