---
name: xrk-subserver
description: 子服插件开发；配置全在主服 CommonConfig，子服只读 data/；AgentRuntime.callSubserver 用 runtimeConfig.subserver。
---

## 配置（必读）

**[docs/subserver-commonconfig.md](../../docs/subserver-commonconfig.md)**

| 类型 | 主服编辑 | 子服 |
|------|----------|------|
| 子服 host/port | AiWorkflow → 子服务端（`runtimeConfig.subserver`） | 被连接 |
| 业务插件 | `apis/<group>/core/commonconfig/*.js` | `load_plugin_config` 只读 yaml |

## 插件结构

```
apis/<group>/
  service.*
  default_config.yaml
  core/commonconfig/<group>.js
  core/plugin/*.js
```

## 本机前置与验收

完整步骤见 **[subserver/SETUP.md](../../subserver/SETUP.md)**「本机前置」：

1. `pnpm subservers:check` — 工具链 + 端口空闲（缺工具只标 `✗`，不强制失败）
2. 起子服 — `pnpm docker:up` 或本机 `SUBSERVER_RUNTIME_CATALOG.start`
3. `pnpm test:subservers` — 连通性冒烟（未启动则 FAIL；可 `--runtime <id>`）

## 文档

- [subserver-plugin-development.md](../../docs/subserver-plugin-development.md)
- [subserver/CONTRACT.md](../../subserver/CONTRACT.md)
- [docs/subserver-api.md](../../docs/subserver-api.md) · [docs/docker.md](../../docs/docker.md)

参考：`subserver/pyserver/apis/jmcomic/`、`media-tools/`。
