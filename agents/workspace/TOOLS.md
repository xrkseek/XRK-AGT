# TOOLS.md — 本机与环境备注

把**只对你这台机器 / 这个账号成立**的信息写在这里，助手不必每次在聊天里重复问。

## 本机能力（与 ENV.md 同步）

Python、pandoc、本机命令是否可用。缺依赖时助手会降级（例如先出 Markdown），并在你确认后更新 ENV。

## 办公与协作

- 常用邮箱 / 署名：
- 企业微信 / 飞书 / 钉钉 习惯用语：
- 文档默认存放：（例：工作区下 `docs/`）

## 设备与路径

- 打印机 / 扫描仪：
- 常用共享盘 / SSH 别名：
- 本机 AgentRuntime 访问地址：（例：`http://127.0.0.1:端口`）

## 技能分类（工作区 `skills/`）

| 类别 | 技能 |
|------|------|
| 基础 | agent-core, agent-tools, agent-core-dev, agent-skillhub, agent-search, agent-browser, agent-memory, answer-format |
| 沟通 | office-email, office-outreach, office-internal, office-meeting, office-meeting-prep, office-transcribe |
| 文稿 | office-doc, office-docx, office-copy, office-proofread, office-research, office-plan, office-briefing |
| 对外 | office-press, office-changelog, office-repurpose, office-faq |
| 表格 | office-sheet, office-xlsx, office-csv, office-chart |
| 演示 | office-pptx |
| PDF | office-pdf |
| 环境 | office-env-setup, office-env-workspace, office-env-shell, office-env-web, office-env-desktop |
| 长文 | office-long-doc, office-tech-writing |

完整列表以对话里的 `<available_skills>` 为准；新技能从仓库 `.xrk/skills` 同步，**工作区已有同名技能时保留工作区版本**。

## 工作区与项目根

- 助手**只写**本工作区；业务代码：`core/workspace-Core/`
- **可读**项目根（相对本目录 `../../../`）：`.cursor/skills`、`docs`、仓库示例——见技能 **agent-core-dev**

| 你想让助手… | 对应做法 |
|-------------|----------|
| 改某一段字 | 局部替换（先找到再改那一块） |
| 新建一份草稿 | 写入新文件 |
| 整篇换一版 | 全文写入并明确覆盖（需你同意） |
| 先看看有什么 | 列目录、读文件、搜关键词 |

细则见 [docs/agents.md](../../docs/agents.md)。

## 格式

- 一条一行，用 `##` 分块
- 有变更就更新本文件，不必在聊天里重复
