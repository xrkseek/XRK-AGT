# Strix 安全扫描（外部工具 · 运维/CI）

> 官方：[usestrix/strix](https://github.com/usestrix/strix) · 文档：[usestrix-strix.mintlify.app](https://usestrix-strix.mintlify.app/)  
> 本仓库**不**把 Strix 嵌入 `AgentRuntime`、不做成聊天插件、不随 `node dist/app.js` 启动。

## 为什么不进 Runtime

| 做法 | 结论 |
|------|------|
| Core 插件 / HTTP「一键渗透」 | **禁止**：通道（QQ/飞书等）可被滥用去扫任意目标；与 Runtime 热路径无关 |
| 对话 Agent「自己装上 Strix 去打」 | **禁止**：会生成/执行攻击与 PoC，超出本助手边界 |
| 本机 CLI / GitHub Actions 扫**自有**仓与自有环境 | **推荐**：与 [AUTH.md](AUTH.md)、[代码审查清单](代码审查清单.md) 互补 |

鉴权、Helmet、速率限制等**防御面**仍以仓库内配置与代码为准；Strix 只做**可选的外部验证门**。

## 前置条件

1. **Docker Desktop**（沙箱硬依赖；Windows 需开 **WSL2**，且终端里 `docker version` 能通）
2. Python **≥ 3.12**（本机可用 `pip`/`pipx`）
3. LLM：`STRIX_LLM`、`LLM_API_KEY`（见官方 README）
4. **仅**扫描你有权测试的目标：本仓库检出目录、本机 `127.0.0.1`、自有 staging——勿对第三方站点

官方安装说明：[Installation](https://usestrix-strix.mintlify.app/installation)

## Windows（PowerShell）安装

官方 `curl … | bash` 面向 Linux/macOS/WSL。原生 Windows **优先下独立二进制**（pip 常因缺 MSVC/`link.exe`、编译 litellm 失败）。

需要走代理时（把下方 URL 换成你本机代理，勿提交个人端口到仓库）：

```powershell
$proxy = 'http://127.0.0.1:<port>'
$env:HTTP_PROXY = $proxy; $env:HTTPS_PROXY = $proxy
```

```powershell
# 1) Docker Desktop（WSL2）装好并启动：
docker version

# 2) 独立二进制（推荐；版本号以 Releases 为准）
$dir = Join-Path $env:LOCALAPPDATA 'strix-bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L --proxy $proxy -o "$dir\strix.zip" `
  https://github.com/usestrix/strix/releases/download/v1.3.1/strix-1.3.1-windows-x86_64.zip
Expand-Archive "$dir\strix.zip" $dir -Force
Copy-Item -Force "$dir\strix-*-windows-x86_64.exe" "$dir\strix.exe"
$env:Path = "$dir;$env:Path"
strix --version

# 3) 配置模型
$env:STRIX_LLM = "openai/gpt-4o"
$env:LLM_API_KEY = "你的密钥"
```

也可在 **WSL2** 里：`curl -sSL https://strix.ai/install | bash`，并保证 WSL 能访问已启动的 Docker。

## 本机（白盒 · 源码）

```bash
# Linux / macOS / WSL（以 https://github.com/usestrix/strix 为准）
curl -sSL https://strix.ai/install | bash

export STRIX_LLM="openai/gpt-4o"   # 按你账号可用的模型改
export LLM_API_KEY="..."

# 在仓库根：快速头less，结果写 stdout；发现漏洞时非 0 退出
strix -n -t ./ --scan-mode quick
```

跑完产物常在 `strix_runs/`（已进根 `.gitignore`）。报告里的问题回到本仓用正常 PR 修：鉴权见 [AUTH.md](AUTH.md)，中间件见 [server.md](server.md#安全与中间件)。

## 本机（灰盒 · 已启动的 AGT）

先 `node dist/app.js`，确认端口与 Key 策略，再只对回环地址：

```bash
strix -n -t http://127.0.0.1:<port> --scan-mode quick \
  --instruction "Owned XRK-AGT local instance. Prefer /api auth, loopback rules, www mounts; do not scan third-party hosts."
```

不要在 instruction 或 target 里塞他人域名。

## CI（GitHub Actions）

工作流：`.github/workflows/strix-security.yml`

- 默认 **`workflow_dispatch` 手动触发**（省 LLM 费用、避免无密钥 PR 失败）
- 仓库 Secrets：`STRIX_LLM`、`LLM_API_KEY`
- 默认 `strix -n -t ./ --scan-mode quick`（PR 场景官方会尽量按 diff 缩小范围；完整历史见 workflow 内 `fetch-depth`）

需要「每个 PR 自动扫」时，在该 yaml 里打开注释掉的 `pull_request` 触发即可，并保证 Secrets 已配置。

托管一键集成也可看官方 [app.strix.ai](https://app.strix.ai)（可选，非本仓依赖）。

## 与 XRK 审查清单的关系

| 层 | 工具 |
|----|------|
| 日常 | `pnpm test:fast`、[代码审查清单](代码审查清单.md) §安全、[AUTH.md](AUTH.md) |
| 发版前可选 | 本机或 Actions 跑 Strix quick / standard |
| 大改 HTTP/鉴权后 | 再对自有 staging 做灰盒 |

发现项请按严重度修代码与配置；**不要**把 Strix 的 PoC 脚本提交进 `core/` 或 `src/`。
