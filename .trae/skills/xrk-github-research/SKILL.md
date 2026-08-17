---
name: xrk-github-research
description: 在 GitHub 搜索成熟开源实现、对比方案、读 issue/PR 时使用。架构选型、unfamiliar 领域、找业界最佳实践时主动调用。
---

## 权威入口

- GitHub MCP（可选；在本机 Cursor MCP 配置中提供 PAT，见 `.cursor/mcp.json.example`）
- CLI：`gh search repos|code|issues`
- 兜底：`WebSearch` + README / 官方文档

## 执行步骤

1. **先本仓库** — `Grep` / `Glob` → `docs/`、`core/`、`.cursor/skills/xrk-*`
2. **GitHub** — 找项目（stars + 近期 commit）→ 读 README + 核心模块 → 必要时 issue/PR
3. **输出** — 结论 · 参考表（项目/为何相关/可借鉴）· 与 XRK 落地方式 · 建议下一步

搜索词示例：`{领域} {栈} language:JavaScript stars:>300 pushed:>2024-01-01`

```powershell
gh search repos "关键词" --sort stars --limit 10
gh api repos/owner/repo/contents/path/to/file -H "Accept: application/vnd.github.raw"
```

## 常见陷阱

- 只搜不读；忽略维护度；有 MCP 仍凭训练数据编 API
- 外部方案违反 XRK 边界（改 `src/infrastructure/`、配置放错目录）
- 替代已有 `xrk-*` skill，而非补充
