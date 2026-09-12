# Docker 部署

> `docker-compose.yml` · `Dockerfile` · `docker-entrypoint.sh` · 栈管理 `src/utils/docker-stack.mjs` · Skill [`.cursor/skills/xrk-docker/SKILL.md`](../.cursor/skills/xrk-docker/SKILL.md)

![Docker Compose 服务栈](../resources/mdimg/docs/docker-compose-stack.png)

## 本机前置与烟测

| 步骤 | 命令 | 说明 |
|------|------|------|
| 1. 工具链 | 安装并启动 **Docker Desktop**（CLI `docker` 在 PATH） | 未装时 `pnpm docker:build` 会报「Docker 未运行」 |
| 2. 静态烟测 | `pnpm docker:check` | 校验 `node:26-slim`、entrypoint → `dist/start.js`、可选 `runtime-browser`；**不依赖 daemon** |
| 3. 构建 | `pnpm docker:build` | 全栈镜像（需 daemon） |
| 4. 可选 browser | `pnpm docker:build:browser` | `XRK_DOCKER_TARGET=runtime-browser`（Playwright Chromium） |

## Node 26 与 entrypoint

- 镜像基线：`Dockerfile` 的 `builder` / `runtime` 均为 **`node:26-slim`**（与 `package.json` `engines.node` ≥26 一致）。
- 入口：`ENTRYPOINT` → `docker-entrypoint.sh`；`CMD ["server"]` → `node … dist/start.js server $PORT`。
- Python 同镜像：`command: subserver` → 子服目录 `.venv` / `python3 main.py`。
- 勿在文档写 Node 24 / `node-fetch`；运行时约定见 [node-26-runtime.md](node-26-runtime.md)。

## 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| `xrk-agt` | 8080 | 主 AgentRuntime（HTTP/WS/控制台） |
| `xrk-subserver` | 8000 | Python 子服（同镜像，`command: subserver`） |
| `xrk-subserver-go/php/java/net/rust` | 8001–8005 | 各语言子服 |
| `redis` | 6379（内部） | 框架内置数据库 |

主服通过 `SUBSERVER_*_HOST` 连接子服。镜像**不含** LLM/Whisper 等模型权重。

## 命令

```bash
pnpm docker:check           # 本机前置 + 静态烟测（无 daemon 也可）
pnpm docker:build           # 构建（默认本地缓存）
pnpm docker:build:browser   # 仅 xrk-agt + Playwright（可选）
pnpm docker:up              # 启动全栈（构建完成后执行）
pnpm docker:status          # 容器状态 + HTTP 健康探测
pnpm docker:down            # 停止
pnpm docker:clean           # 删除全部容器/镜像/缓存
pnpm docker:fresh           # clean + --pull 构建 + 启动（从零重来）
node src/utils/docker-stack.mjs build --pull   # 强制拉 base 镜像
```

### 构建成功后

```bash
pnpm docker:up
pnpm docker:status
pnpm test:subservers    # 可选：子服 8000–8005 冒烟
```

浏览器打开 `http://127.0.0.1:8080`（Web 控制台 `/xrk/`）。日志：`docker compose logs -f xrk-agt`。

子服冒烟（本地 `tests/`，不入库）：`pnpm test:subservers`

## 环境变量

根目录 `.env` 或 `config/docker.env`（后者已在 `.gitignore`）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `XRK_SERVER_PORT` | 8080 | 主服端口 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 空 | 容器出网（LLM API 等） |
| `BUILD_HTTP_PROXY` | 空 | 构建阶段代理（Docker VM 内用 `host.docker.internal`） |

## 持久化卷

`./data` · `./logs` · `./config` · `./resources` · `./core`

Docker 内 Redis 地址自动从 `127.0.0.1` 映射为服务名 `redis`。

## 故障排查

- **Docker 未安装 / 未运行** — 先装并启动 Docker Desktop；无 daemon 时用 `pnpm docker:check` 做静态烟测，完整 `docker:build` 需 daemon。
- **端口占用** — 改 `XRK_SERVER_PORT` 或 compose 端口映射。
- **构建慢 / auth.docker.io 超时** — 检查代理、`config/docker.env`、镜像源；日常用 `docker:build`（本地缓存），仅 `docker:fresh` 或 `build --pull` 强制拉 base。
- **健康检查失败** — `pnpm docker:status` 或 `docker compose logs <服务名>`。主服会等 redis/全部子服 healthy 后再启动。

子服联调细节见 [subserver/SETUP.md](../subserver/SETUP.md)。

---

*最后更新：2026-09-12*
