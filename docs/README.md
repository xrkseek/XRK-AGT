# XRK-AGT 文档中心

欢迎来到 XRK-AGT 框架文档中心。仓库根目录 [README.md](../README.md) 负责安装与启动；**本页**负责开发文档索引与阅读路径。

![XRK-AGT 文档中心](../resources/mdimg/docs/docs-hub-banner.png)

| 我想… | 从这里开始 |
|--------|------------|
| 跑起来 | [README.md §快速开始](../README.md#-快速开始) · [startup.md](startup.md) |
| **看实拍** | [README §项目展示](../README.md#-项目展示) |
| **写业务（先看挂载）** | **[runtime-surface.md](runtime-surface.md)** → [base-classes.md](base-classes.md) |
| **写法与性能** | **[coding-style.md](coding-style.md)** → [node-26-runtime.md](node-26-runtime.md) |
| **Cursor / 框架开发约定** | 根 [AGENTS.md](../AGENTS.md) · `.cursor/skills/` |
| **办事助手（群聊/控制台）** | **[agents.md](agents.md)** · **[agent-context.md](agent-context.md)** · 种子 [agents/](../agents/) |
| 懂架构 | [底层架构设计](底层架构设计.md) → [startup.md](startup.md) → [database.md](database.md) |
| 用内置能力 | [system-core.md](system-core.md) |
| 写插件 / API / 工作流 | [框架可扩展性指南](框架可扩展性指南.md) |
| 发布前检查 | [框架测试指南](框架测试指南.md) → [代码审查清单](代码审查清单.md) → [文档审查清单](文档审查清单.md) |

> 配图约定：[DOCSTYLE.md](DOCSTYLE.md) · 仓库 [github.com/xrkseek/XRK-AGT](https://github.com/xrkseek/XRK-AGT)

## 目录

- [仓库目录速查](#仓库目录速查避免误放重复)
- [文档导航](#-文档导航)
- [按角色推荐阅读](#-按角色推荐阅读)
- [典型开发路径](#典型开发路径)
- [相关资源](#相关资源)

---

## 仓库目录速查（避免误放/重复）

| 路径 | 用途 | 是否入库 |
|------|------|----------|
| `src/` | 运行时与基础设施（**勿写业务**） | 是 |
| `core/<name>/` | 业务：plugin / http / workflow / tasker / events / commonconfig / www | system-Core 是 |
| `config/default_config/` | 配置模板（仅 AGT / 工厂 / system-Core；产品业务 yaml 见 `core/<名>/default/`） | 是 |
| `data/` | 运行期数据（按端口分目录；办事助手工作区在 `data/ai-workspace/`） | 否（gitignore） |
| `agents/` + `.xrk/skills/` | 办事助手种子：`workspace/` · `rules/` · `.xrk/skills/` · `subagents.yaml`（契约 [agents.md](agents.md)、种子 [agents/README.md](../agents/README.md)） | 是 |
| 根 `AGENTS.md` | Cursor / 框架开发入口 | 是 |
| `core/system-Core/www/xrk/` | 内置 Web 控制台 | 是 |
| `core/system-Core/site/` | 站点根静态（`/`，favicon 等；`paths.www`） | 是 |
| `.cursor/` | Cursor 技能、规则、命令（**权威副本**） | 是 |
| `.claude/`、`.trae/` | 由 `sync-skills.ps1` 生成的 IDE 副本 | 否（gitignore，可删后重建） |
| `logs/`、`trash/`、`node_modules/` | 日志、回收站、依赖 | 否 |

**HTTP 鉴权**：经 `HttpApi` 注册且路径以 `/api/` 开头时，默认要求系统 API Key（见 [AUTH.md](AUTH.md)、[http-api.md](http-api.md)）。公开接口在路由上设置 `systemAuth: false`。

---

## 📚 文档导航

### 🚀 快速开始

- **[框架测试指南](框架测试指南.md)** - 标准值、实测数据、CI 命令（仅 system-Core；**Node ≥ 26**；集成测 import `bootstrap-globals`）
- **[代码审查清单](代码审查清单.md)** - 发布前代码与架构检查
- **[文档审查清单](文档审查清单.md)** - 发布前文档准确性、互链与数字一致性 ⭐
- **[项目概览](../PROJECT_OVERVIEW.md)** - 目录树与文档入口（架构图见底层架构设计）
- **[底层架构设计](底层架构设计.md)** - Runtime / Infrastructure / Core 分层与 AI 链路（**架构单一事实源**） ⭐
- **[启动与引导](startup.md)** - `app.js` → bootstrap → `start.js` → AgentRuntime，环境变量与 Playwright ⭐
- **[运行时挂载面](runtime-surface.md)** - 全局对象、AgentRuntime Proxy、Loader 单例、按场景写法 ⭐ **开发首读**
- **[底层写法规范](coding-style.md)** - 全局裸名、状态/I/O/异步/HTTP、性能速查 ⭐
- **[业务基类契约](base-classes.md)** - plugin / HttpApi / AiWorkflow 最小 export
- **[文档编写规范](DOCSTYLE.md)** - 维护者标注化模板
- **[Node 26 运行时约定](node-26-runtime.md)** - 版本要求、已用 API（禁止项见 skill `xrk-node-runtime`）
- **[AgentRuntime 主类文档](agent-runtime.md)** - AgentRuntime 生命周期、HTTP/WebSocket（挂载面见 runtime-surface）
- **[基础设施共享约定](infrastructure-shared.md)** - Loader 标准模式、热重载、`bootstrap-globals`
- **[框架可扩展性指南](框架可扩展性指南.md)** - 7 大扩展点与 Core 开发完整说明，包含最佳实践和代码质量规范 ⭐

### 🏗️ 架构

分层与职责见 **[底层架构设计](底层架构设计.md)**（本页不重复架构图）。业务实现放在 `core/*/`；`src/` 为基础设施，**勿写业务 API/工作流**。

**system-Core 内置模块**：11 HTTP / 7 工作流 / 15 插件 / 4 Tasker / 4 events；MCP 工具在七个自带工作流内合计 **80** 个（`registerMCPTool` 计数）。详见 **[system-Core 特性文档](system-core.md)**；标准值见本地 **`tests/helpers/system-core.mjs`**（`tests/` 不入库）与 **[框架测试指南](框架测试指南.md)**。

### 🔌 插件与事件系统

- **[插件基类文档](plugin-base.md)** - `plugin` 基类：事件链路、规则/上下文、工作流集成 ⭐
- **[插件加载器文档](plugins-loader.md)** - `PluginLoader` 的插件加载、事件调度、冷却与节流机制
- **[事件系统标准化文档](事件系统标准化文档.md)** - 事件命名规范、字段责任、处理流程、事件监听器开发指南

### 🔄 Tasker 系统（任务层/事件生成器）

- **[Tasker 加载器文档](tasker-loader.md)** - `TaskerLoader` 如何扫描并加载 Tasker（事件生成器）
- **[Tasker 底层规范](tasker-base-spec.md)** - Tasker 基础接口规范
- **[OneBotv11 Tasker 文档](tasker-onebotv11.md)** - OneBotv11 Tasker 完整文档，包含全局对象说明和使用示例

### 🌐 HTTP/API 层

- **[HTTP API 基类文档](http-api.md)** - `HttpApi` 基类，统一路由、WebSocket 与中间件注册方式
- **[API 加载器文档](api-loader.md)** - `HttpApiLoader` 的 API 自动加载、排序与热重载机制
- **[Server 服务器架构文档](server.md)** - HTTP/HTTPS/WebSocket 服务、反向代理、静态文件服务等完整说明
- **[www 挂载（零配置静态 / sign.json）](www-mount.md)** - 纯静态与前端工程、`sign`↔`server` 合并（权威）
- **[鉴权与认证（AUTH）](AUTH.md)** - 系统级 API Key、各层职责与推荐鉴权方式
- **[Strix 安全扫描（外部 CI）](security-strix.md)** - 可选 usestrix/strix；不进 Runtime，仅自有目标
- **[HTTP 业务层文档](http-business-layer.md)** - 重定向、CDN、反向代理增强、负载均衡等企业级功能
- **[system-Core 特性文档](system-core.md)** - system-Core 内置模块完整说明，包含所有HTTP API、工作流、插件和Web控制台 ⭐

### 🤖 AI 工作流

- **说明**：Node 侧统一通过工作流 + MCP 工具完成能力编排；如需 Python 侧能力，请在子服务端按 `apis/<group>/*.py` 扩展自定义接口。
- **[底层架构设计](底层架构设计.md)** - AI 主链路、AiWorkflow 链路、子服务端职责边界（权威）
- **[办事助手说明](agents.md)** - 怎么用、改哪里、工作区注入、Agents 清单、实现索引；框架写码见根 [AGENTS.md](../AGENTS.md)
- **[Agent 运行链与上下文](agent-context.md)** - **概念地图** + mergeWorkflows、消息三层、**出站压缩/策略安全/斜杠**、Workspace/skills、工具环 ⭐
- **[MCP 完整指南](mcp-guide.md)** - MCP 工具注册与连接（含 `apply_edit` / `repo_map` 等）
- **[MCP 配置指南](mcp-config-guide.md)** - Cursor、Claude Desktop 等外部平台连接配置
- **[AiWorkflow 工作流基类文档](ai-workflow.md)** - `AiWorkflow` 基类；`context` / `policies` / `security` / `recipes` 配置键；禁止文本假 ReAct
- **[工厂系统文档](factory.md)** - LLM（含多模态）/ASR/TTS 工厂系统，统一管理多厂商 AI 服务提供商
- **[子服务端 API 文档](subserver-api.md)** - Python 子服务端底层系统接口与扩展装载说明

**技能分流**：Coding → `.cursor/skills/xrk-*`；产品 Agent → `.xrk/skills/`（见 [SKILL_INDEX](../.cursor/skills/SKILL_INDEX.md)）。

### ⚙️ 配置与工具

- **[配置基类文档](config-base.md)** - 配置基类 `ConfigBase`，包括 YAML/JSON 读写、校验、按路径读写、多文件配置等
- **[Redis（框架内置数据库）](database.md)** - 连接配置、启动流程、全局客户端、环境变量与 Docker ⭐
- **[渲染器基类文档](renderer.md)** - 渲染器基类 `Renderer`，模板渲染与文件监听机制
- **[RuntimeUtil 工具类文档](runtime-util.md)** - 工具类 `RuntimeUtil`，封装日志、缓存、文件/网络操作与异步控制等基础能力

### 🧱 基础设施约定

- **[运行时挂载面](runtime-surface.md)** - AgentRuntime / global / req 注入透明清单 ⭐
- **[业务扩展基类契约](base-classes.md)** - 各基类最小 export
- **[基础设施共享约定](infrastructure-shared.md)** - Loader 标准模式、热重载、`bootstrap-globals`
- **[文档编写规范](DOCSTYLE.md)** - 文档分层与单篇模板

### 📱 应用开发

- **[应用开发指南](app-dev.md)** - Web 控制台、前后端协作、runtimeConfig 体系
- **[启动与引导](startup.md)** - 引导链、环境变量、Playwright 浏览器 ⭐
- **[Docker 部署指南](docker.md)** - Docker 容器化部署说明，包含 docker-compose 配置和使用指南

---

## 🎯 按角色推荐阅读

| 角色 | 首读 | 扩展 |
|------|------|------|
| Cursor / 框架维护者 | 根 [AGENTS.md](../AGENTS.md) · [runtime-surface.md](runtime-surface.md) · [coding-style.md](coding-style.md) | `.cursor/skills/` · [框架可扩展性指南](框架可扩展性指南.md) |
| 插件开发者 | **[runtime-surface.md](runtime-surface.md)** · [base-classes.md](base-classes.md) · [框架可扩展性指南](框架可扩展性指南.md) · [plugin-base.md](plugin-base.md) | [plugins-loader.md](plugins-loader.md) · [ai-workflow.md](ai-workflow.md) |
| Tasker 开发者 | [tasker-loader.md](tasker-loader.md) · [tasker-base-spec.md](tasker-base-spec.md) | [tasker-onebotv11.md](tasker-onebotv11.md) · [agent-runtime.md](agent-runtime.md) |
| 后端 / API | [http-api.md](http-api.md) · [base-classes.md](base-classes.md) · [agent-runtime.md](agent-runtime.md) · [AUTH.md](AUTH.md) | [api-loader.md](api-loader.md) · [infrastructure-shared.md](infrastructure-shared.md) |
| 运维 / 配置 | [config-base.md](config-base.md) · [database.md](database.md) · [docker.md](docker.md) | [factory.md](factory.md) · [server.md](server.md) |
| 前端 / 渲染 | [app-dev.md](app-dev.md) · [www-mount.md](www-mount.md) · [renderer.md](renderer.md) | [system-core.md](system-core.md) · skill `xrk-www-compat` |
| 办事助手运营 | **[agents.md](agents.md)** · [agents/README.md](../agents/README.md) | [agent-context.md](agent-context.md) · `data/ai-workspace/` · [ai-workflow.md](ai-workflow.md) |

架构与目录：**[底层架构设计](底层架构设计.md)** · **[PROJECT_OVERVIEW](../PROJECT_OVERVIEW.md)**（目录树）· **[startup.md](startup.md)**（启动链）。

---

## 典型开发路径

### 创建自己的 Core 模块

业务均在 `core/` 下按模块开发；每个 core 内含 `plugin/`、`tasker/`、`events/`、`http/`、`workflow/`、`commonconfig/`、`www/<目录名>/` 等业务目录（按需创建）。继承对应基类、使用 `#` 别名导入、放置到约定目录即可自动加载。

**完整流程与目录说明**：详见 **[框架可扩展性指南 - Core 模块开发](框架可扩展性指南.md#core-模块开发)** ⭐

### 编写一个简单指令插件

1. [plugin-base.md](plugin-base.md) · [plugins-loader.md](plugins-loader.md)
2. 在 `core/<name>/plugin/` 下新建插件文件

### 新增一个 API 接口

1. 阅读 **[HTTP API 基类文档](http-api.md)** 与 **[API 加载器文档](api-loader.md)**
2. 在任意 core 目录的 `http/` 子目录下新建一个 `.js` 文件，导出一个符合 `HttpApi` 结构的对象或类
3. 重启或等待 `HttpApiLoader` 热重载，使用浏览器或 Postman 验证新接口

### 接入新的 IM 平台（创建新 Tasker）

1. [tasker-loader.md](tasker-loader.md) · [tasker-base-spec.md](tasker-base-spec.md) · 参考 [tasker-onebotv11.md](tasker-onebotv11.md)
2. 在 `core/<name>/tasker/` 编写 Tasker，在 `events/` 编写监听器（见 [事件系统标准化文档](事件系统标准化文档.md)）

### 创建新的 AI 工作流

1. 阅读 **[AiWorkflow 工作流基类文档](ai-workflow.md)** 了解基类设计
2. 阅读 **[工厂系统文档](factory.md)** 了解如何选择和使用 LLM 提供商
3. 在任意 core 目录的 `workflow/` 子目录中创建新的工作流文件
4. 基于 `AiWorkflow` 实现自定义工作流逻辑
5. 在插件或 API 中调用新工作流

配置注入与办事助手工作区见 **[agents.md](agents.md)**（`agentWorkspace`）。

### 接入新的 AI 服务提供商

1. 阅读 **[工厂系统文档](factory.md)** 了解工厂系统的设计和扩展方式
2. 实现新的客户端类（遵循接口规范）
3. 使用工厂的 `registerProvider()` 方法注册新提供商
4. 创建对应的配置文件（如 `myprovider_llm.yaml`）
5. 在配置管理界面中配置 API Key 等参数

### 配置外部 AI 平台连接（MCP）

1. 阅读 **[MCP 配置指南](mcp-config-guide.md)** 了解如何配置 Cursor、Claude Desktop 等外部平台
2. 阅读 **[MCP 完整指南](mcp-guide.md)** 了解 MCP 工具注册与连接机制
3. 在外部平台配置文件中添加 XRK-AGT 的 MCP 服务器地址

### 部署到生产环境

1. 阅读 **[Docker 部署指南](docker.md)** 了解容器化部署
2. 阅读 **[Server 服务器架构](server.md)** 了解服务器配置
3. 阅读 **[HTTP 业务层](http-business-layer.md)** 了解反向代理、负载均衡等企业级功能

---

## 🔍 全局对象与 AgentRuntime

**完整挂载表**（含 Proxy 透传 `RuntimeUtil`、HTTP 业务层方法、`req.agentRuntime`）：**[runtime-surface.md](runtime-surface.md)**。

AgentRuntime 生命周期、HTTP/WS、关闭流程：**[agent-runtime.md](agent-runtime.md)**。OneBot 子 AgentRuntime 结构：**[tasker-onebotv11.md](tasker-onebotv11.md)**。

---

## ⚠️ 重要提示

1. **架构层次**：理解基础设施层（辅助层）和业务层的区别，基础设施层提供通用能力，业务层实现具体功能
2. **全局对象访问**：始终通过 `AgentRuntime[self_id]` 访问 AgentRuntime 实例，不要直接使用 `e.bot`（除非确保已初始化）
3. **事件命名**：`{tasker}.{post_type}.{detail?}.{sub_type?}`，如 `onebot.message` / `onebot.message.group`；插件可用跨 Tasker 的 `message`（见 [事件系统标准化文档](事件系统标准化文档.md)）
4. **错误处理**：异步操作用 try/catch；基础设施层用 `Error.isError` / `normalizeError`
5. **AgentRuntime 实例**：通过 `node app` 启动，勿手动 `new AgentRuntime()`
6. **Ctrl+C**：服务端 1 次重启 / 3 次回菜单（见 [agent-runtime.md](agent-runtime.md)）；勿在业务代码自行 `process.on('SIGINT')`
7. **Node.js ≥ 26**、**pnpm** 为硬性要求（见 [node-26-runtime.md](node-26-runtime.md)）

---

## 相关资源

- **[README.md](../README.md)** - 仓库入口、目录导航、测试与质量摘要
- **[项目概览](../PROJECT_OVERVIEW.md)** - 项目整体架构说明
- **[文档审查清单](文档审查清单.md)** - 文档层级图与发布前自检
- **[XRK-AGT 生态索引（AGT-Cores-Tools-Index）](https://github.com/xrkseek/AGT-Cores-Tools-Index)** - 官方导航仓库（含 [核心工具与通用组件索引](https://github.com/xrkseek/AGT-Cores-Tools-Index/blob/main/Core-Tools.md) 等，以该仓库为准）
- **[GitHub 仓库](https://github.com/xrkseek/XRK-AGT)** - 源代码仓库
- **[Gitee 仓库](https://gitee.com/xrkseek/XRK-AGT)** - 国内镜像仓库
- **[GitCode 仓库](https://gitcode.com/Xrkseek/XRK-AGT)** - 国内镜像仓库

---

*最后更新：2026-06-19*

