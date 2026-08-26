# AGENTS.md — XRK-AGT

面向**克隆本仓、开发 / 维护 Core**（以及排查 Runtime）的开发者与 Coding Agent。

## 角色边界

| 你是谁 | 改哪里 | 不要改 |
|--------|--------|--------|
| **Core 开发者**（默认） | `core/<你的Core>/` | `src/`；产品业务配置勿写入 `config/default_config/` |
| **框架维护者** | `src/` · `config/default_config/` · `core/system-Core/` | 业务逻辑塞进 `src/` |

主仓 git 通常只收录 `system-Core`；业务 Core 本地放在 `core/<名>/`（可独立 git）。入库边界见 `.cursor/rules/xrk-third-party-plugins.mdc`。

## 栈与启动

- Node ≥ 26 · 包管理仅 **pnpm**
- `node app` → `start.js` → `src/agent-runtime.js`
- 首读：[docs/runtime-surface.md](docs/runtime-surface.md) · [docs/coding-style.md](docs/coding-style.md) · [docs/base-classes.md](docs/base-classes.md) · 索引 [docs/README.md](docs/README.md)

## 放码

```
core/<core>/
  plugin/  http/  workflow/  tasker/  events/  commonconfig/
  default/           # 产品配置模板
  www/<应用名>/      # 必须子目录；勿用 api|core|media|uploads|File|shared
```

| 约定 | 做法 |
|------|------|
| 导入 | 无 `package.json` 用 `#infrastructure/*`、`#utils/*`；有则相对路径引用根 `src/`（子包无 `#`） |
| HTTP | `HttpResponse`（`#utils/http-utils.js`）；`success` 普通对象字段拍平到顶层 |
| 全局 | `AgentRuntime`、`msgSegment` 裸名（勿 `import` / `global.`） |
| 产品配置 | `core/<core>/default/` + `commonconfig/` + `data/<产品>/` |
| 易变状态 | 类字段或 `init()`；勿在 `constructor` 建缓存 Map |

编码硬约束：`.cursor/rules/xrk-dev-requirements.mdc`。

## 本仓规则

| 规则 | 作用 |
|------|------|
| `xrk-project.mdc` | 架构、配置归属、上游链接、提交署名 |
| `xrk-dev-requirements.mdc` | 裸名全局、HttpResponse、www、Node 26 |
| `xrk-third-party-plugins.mdc` | 主仓 gitignore / 子服 `apis/` |

改 `core/` / `src/` 前：Grep 调用方 → 读对应 skill → 再动手。任务→Skill 表：[`.cursor/skills/SKILL_INDEX.md`](.cursor/skills/SKILL_INDEX.md)。

文档 / skill 与实现冲突时以**代码**为准。

## Core 内文档

| 文件 | 读者 | 写什么 |
|------|------|--------|
| `README.md` | 开发者 | 部署、API、与 AGT 集成 |
| `AGENTS.md` · `skills/`（若有） | 产品 Agent | 工作区与工具边界；**不写** LLM 工厂 / commonconfig / `src` 路径 |
| 独立 Core 仓 `.cursor/rules/` | 该产品 | 精工约定；**勿**塞进主仓 alwaysApply |

办事助手（产品模型，不是写框架）：[docs/agents.md](docs/agents.md) · `agents/` + `.xrk/skills/`。
