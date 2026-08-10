# 文档编写规范

> 维护者与新文档作者请遵循本规范，保证开发者「看得舒服、找得到源码、不重复」。

---

## 文档分层

| 层级 | 文件 | 写什么 |
|------|------|--------|
| L0 入口 | `README.md` | 安装、首读路径、外链 |
| L1 枢纽 | `docs/README.md` | 全量索引、按角色阅读 |
| L1 边界 | `底层架构设计.md` | 分层、工具表、AI/配置索引（**唯一架构图**） |
| L1 运行时 | **`runtime-surface.md`** | 全局/AgentRuntime/Loader 挂载（**唯一挂载面**） |
| L1 写法 | **`coding-style.md`** | Core/src 写法与性能（**唯一写法规范**） |
| L1 契约 | `base-classes.md` | 基类最小 export 示例 |
| L2 专题 | `plugin-base.md`、`http-api.md` 等 | 单点 API、流程图、配置字段 |

**禁止**：在 L0/L1 概览中复制大段 mermaid 或 Node 26 禁止项；改为链接权威文档。

---

## 单篇模板

每篇 `docs/*.md` 建议结构：

```markdown
# 标题

> **源码**：`path/to/file.js`（函数/类名）  
> **读者**：插件开发者 / 运维 / …  
> **关联**：[runtime-surface.md](runtime-surface.md) · [其他](other.md)

（可选）一段话说明职责边界。

## 目录

- …

---

## （正文分节，每节解决一个问题）

## 相关文档

- …

---

*最后更新：YYYY-MM-DD*
```

### 元信息块（文首 `>`）必填项

- **源码**：主文件路径；多文件用「 · 」分隔  
- **读者**：谁会在什么场景打开这篇  
- **关联**：链到 `runtime-surface` / `base-classes` / 上级专题，避免孤岛

### 正文约定

- **行为以代码为准**；写清「文件 + 符号名」  
- 配置：YAML 路径 + 字段名 + 一行示例  
- API：method + path + 是否 `systemAuth`  
- 示例代码可运行、与 Node 26 规范一致  
- 同一事实只维护一处；他处用「见 [xxx.md](xxx.md)」

### 配图

| 目录 | 用途 |
|------|------|
| `showcase/` | 实拍（录屏、控制台截图） |
| `docs/` | 概念导读图（**不替代** Mermaid；文内注明以代码/Mermaid 为准） |

**`docs/` 导读图**（按主题，单篇最多引用 1 张）：

| 文件 | 用于 |
|------|------|
| `docs-hub-banner.png` | 文档枢纽 |
| `architecture-layers.png` | 三层架构 |
| `runtime-surface.png` | 运行时挂载 |
| `bot-lifecycle.png` | AgentRuntime 生命周期 |
| `loader-hot-reload.png` | Loader 扫描/热重载 |
| `database-dual-store.png` | Redis（框架内置数据库） |
| `config-base-flow.png` | ConfigBase |
| `http-api-pipeline.png` | HttpApi / HttpApiLoader |
| `seven-extensions.png` | 七大扩展点 |
| `plugin-event-pipeline.png` | 插件事件链 |
| `ai-workflow-mcp-flow.png` | AiWorkflow + MCP |
| `mcp-ecosystem.png` | MCP 生态 |
| `llm-factory.png` | LLM/ASR/TTS 工厂 |
| `docker-compose-stack.png` | Docker 编排 |

- 单篇：导读图 ≤1 张 + 实拍表按需；与上层文档勿重复贴同图
- 生图提示词须符合项目事实：Node ≥26、pnpm、`node app.js`、仓库 `github.com/xrkseek/XRK-AGT`；**禁止** pip/Python/错误仓库名
- 少用大段假代码/假 URL，优先图标 + 准确标签

---

## 变更同步

改底层挂载或基类时，至少更新：

1. `docs/runtime-surface.md`（若影响 global / AgentRuntime / req）  
2. `docs/base-classes.md`（若影响 export 形状）  
3. [文档审查清单.md](文档审查清单.md) 对应行  

改 Loader 行为时更新 `infrastructure-shared.md` + 对应 `*-loader.md`。

---

*最后更新：2026-06-19*
