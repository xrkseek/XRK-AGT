# ENV.md — 本机能力与依赖

> Agent 办事前先读此文件。探测到新能力或缺失项后，**经用户确认**再更新本节。

## 能力档位（探测后勾选）

- [ ] **A 基础**：工作区 `read/write/list_files/grep` 可用
- [ ] **B 桌面**：`open_path` / `open_browser` / `open_explorer` 可用
- [x] **C 命令**：`run` 默认开启（`tools.file.runEnabled: true`；可在配置关闭）
- [ ] **D Python**：`python` / `python3` 可执行
- [ ] **E 网页**：`web_search` / `web_fetch` 可用；需 JS 渲染时用 `browser_*`

## 已安装 CLI / 工具（有则填路径或版本）

| 工具 | 状态 | 备注 |
|------|------|------|
| Python | 未测 | |
| pip | 未测 | |
| pandoc | 未测 | docx/md 互转 |
| LibreOffice (soffice) | 未测 | .doc→docx、转 pdf |
| pdftotext / qpdf | 未测 | PDF 处理 |
| Tesseract OCR | 未测 | 扫描 PDF |
| Node.js | 未测 | 可选 |

## Python 包（按需 pip，确认后再装）

常用：`pandas` `openpyxl` `python-pptx` `pypdf` `pdfplumber` `matplotlib` `faster-whisper`

## 已知限制

- `run` 关闭时：只能用 Markdown 交付，不能跑脚本生成 docx/xlsx
- 无 pandoc：Word 用纯 Markdown 或请用户本地转换
- 无 LibreOffice：不承诺 .doc 老格式转换
- 无 OCR：扫描 PDF 请用户提供可复制文本或手动录入

## 探测记录

| 日期 | 探测项 | 结果 |
|------|--------|------|
| | | |

## 相关配置路径（XRK）

- 工作区：`data/ai-workspace/{id}/`
- 技能种子：`.xrk/skills/`（含 `core/` 基础 + `office-*` 扩展）→ 同步到工作区 `skills/`
- 业务插件种子：`agents/workspace/core/` → 工作区 `core/`（Loader 扫描；见 agent-core-dev）
- 项目规则：`agents/rules/` → 注入 system prompt
- run 开关：`config/default_config/ai-workflow.yaml` → `tools.file.runEnabled`
- 技能注入：`agentWorkspace.customSkillRoots`（默认 `.xrk/skills/core` + `.xrk/skills`）
- 开放域检索：`web.web_search`（`ai-workflow.crawl.webSearch` + 13 提供商；无 Key 默认 parallel-free）。查状态：`web.web_search_providers`
- Web 抓取 / 浏览器：`ai-workflow.crawl.webFetch` / `ai-workflow.crawl.browser`；Playwright 启动参数另见 `renderer.playwright`（控制台 renderer 配置）
