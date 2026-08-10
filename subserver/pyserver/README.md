# XRK-AGT Python 子服务端

基于 FastAPI：健康检查、系统 API、自动装载 `apis/`。

## 要求

- Python ≥ 3.10
- [uv](https://docs.astral.sh/uv/)

## 启动

```bash
cd subserver/pyserver
uv sync
uv run python main.py
```

Windows 也可用 `.\xrk.cmd`。启动时安装各 `apis/*/requirements.txt`。

可见窗口：

```powershell
powershell -ExecutionPolicy Bypass -File subserver/pyserver/scripts/start-visible.ps1
```

## API

| 路径 | 说明 |
|------|------|
| `/docs` | OpenAPI |
| `/health` | 健康检查 |
| `/api/list` | API 列表 |
| `/api/system/*` | ping、config、groups、command 等 |
| 白名单组 | `media-tools`、`doc-pipeline`、`web-fetch`（其余组本地 clone） |

## 交互终端

`server.stdin.enabled: true` 时：

```text
子服> 帮助 | 列表 | 更新 | 清屏 | 退出
```

Ctrl+C 停服；Ctrl+D / `退出` 仅关终端。历史：`data/subserver/stdin_history`。

## 配置

| 文件 | 用途 |
|------|------|
| `config/default_config.yaml` | 默认模板 |
| `data/subserver/config.yaml` | 运行时（首次从模板复制） |

环境变量：`HOST`、`PORT`、`RELOAD`、`LOG_LEVEL`。

## 插件

[docs/subserver-plugin-development.md](../../docs/subserver-plugin-development.md) · 示例 `apis/media-tools/`。
