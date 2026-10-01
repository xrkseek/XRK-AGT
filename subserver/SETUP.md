# 子服务端环境准备

> 运行时目录 [`src/utils/subserver-runtimes.ts`](../src/utils/subserver-runtimes.ts)（构建后为 `.js`）· 契约 [`CONTRACT.md`](CONTRACT.md) · Skill [`.cursor/skills/xrk-subserver/SKILL.md`](../.cursor/skills/xrk-subserver/SKILL.md)

## 本机前置（先做）

| 步骤 | 命令 | 作用 | 失败含义 |
|------|------|------|----------|
| 1. 工具链 | `pnpm subservers:check` | 探测 PATH 上的 node / uv / go / php / java / mvn / dotnet / cargo / docker，以及 8000–8005 是否空闲 | **不因缺工具而 exit≠0**；只打印 `✓/✗`，按需补装 |
| 2. 起子服 | Docker：`pnpm docker:up`；或本机按下方「本机单 runtime」起已装工具链 | 监听对应端口 | 端口占用见 FAQ |
| 3. 冒烟 | `pnpm test:subservers`（可加 `--runtime goserver`） | 对已启动 runtime 打 `/health` 与示例插件 | **未启动的 runtime 会 FAIL**（exit 1）；属预期，不是脚本坏了 |

**Node**：主仓 `engines.node` ≥26；跑 pnpm / 冒烟前用系统 Node（勿用 Cursor helper Node 22），见 `.cursor/rules/xrk-node26.mdc`。

**本机常见缺口（Windows）**：`uv`（pyserver）、`php`（phpserver）、`mvn`（jserver）、`dotnet`（netserver）、`docker`（全栈）常不在 PATH；有 `go` / `cargo` / `java` 时可先起对应单 runtime 做局部冒烟。

## Docker 全栈（推荐）

先启动 Docker Desktop，仓库根目录：

```powershell
pnpm docker:up         # 启动全栈（等待 healthcheck）
pnpm docker:status     # 确认各端口 OK
pnpm test:subservers   # 可选冒烟（需 8000–8005 已在听）
```

从零重来：`pnpm docker:fresh` · 停止：`pnpm docker:down`

## 本机单 runtime

端口与启动命令以 [`src/utils/subserver-runtimes.ts`](../src/utils/subserver-runtimes.ts) 中 `SUBSERVER_RUNTIME_CATALOG` 为准：

| Runtime | 依赖 | 启动（仓库根） |
|---------|------|----------------|
| pyserver | Python 3.12+、[uv](https://docs.astral.sh/uv/) | `cd subserver/pyserver && uv run python main.py` |
| goserver | Go 1.23+ | `cd subserver/goserver && go run .` |
| phpserver | PHP 8.2+ | `cd subserver/phpserver && php run.php` |
| jserver | JDK 21+、Maven | `cd subserver/jserver && mvn -q spring-boot:run` |
| netserver | .NET SDK 8+ | `cd subserver/netserver && dotnet run` |
| rustserver | Rust stable（Windows 无 MSVC 时需 MinGW gcc，见 `rustserver/run.mjs`） | `node subserver/rustserver/run.mjs` |

局部冒烟示例：`pnpm test:subservers -- --runtime goserver`

## 代理（可选）

本机创建 `config/docker.env`（已 gitignore）：

```bash
BUILD_HTTP_PROXY=http://host.docker.internal:<端口>
BUILD_HTTPS_PROXY=http://host.docker.internal:<端口>
CONTAINER_HTTP_PROXY=http://host.docker.internal:<端口>
CONTAINER_HTTPS_PROXY=http://host.docker.internal:<端口>
```

## 常见问题

- **端口占用** — 改 compose 映射并同步主服 `runtimeConfig.subserver`
- **Docker 拉镜像 403** — 检查 `%USERPROFILE%\.docker\daemon.json` 镜像源
- **jserver 首次慢** — Maven 下载依赖

主服调用：`AgentRuntime.callSubserver('/api/...', { runtime: 'goserver', method: 'POST', body })`
