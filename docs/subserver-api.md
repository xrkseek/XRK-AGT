# 子服务端 API 文档

> **目录**：`subserver/`（多语言）· 运行时目录 `src/utils/subserver-runtimes.js`  
> **Python 实现**：`subserver/pyserver/`  
> **说明**：主服务通过 `AgentRuntime.callSubserver` 调用各 runtime 的 `apis/` 插件。

子服务端提供（各 runtime 统一契约）：
- **健康检查**：`GET /health`
- **系统接口**：`GET /api/system/ping`、`GET /api/system/groups`、`POST /api/system/command`
- **插件装载**：各语言 `apis/<group>/`（见 `subserver/README.md`）

| Runtime | 语言 | 默认端口 |
|---------|------|----------|
| `pyserver` | Python | 8000 |
| `goserver` | Go | 8001 |
| `phpserver` | PHP | 8002 |
| `jserver` | Spring Boot | 8003 |
| `netserver` | ASP.NET Core | 8004 |
| `rustserver` | Axum (Rust) | 8005 |

默认端口与路径/启动命令以 [`src/utils/subserver-runtimes.js`](../src/utils/subserver-runtimes.js) 为准。

选型见 [`subserver/LANGUAGES.md`](../subserver/LANGUAGES.md)。主服务已是 Node.js，**不提供 Node 子服务端**。

**Docker**：`docker compose up -d` 启动五 runtime；主服务容器通过 `SUBSERVER_*_HOST` 环境变量自动解析子服务地址。

---

## 📚 目录

- [架构设计](#架构设计)
- [现有 API](#现有-api)
- [扩展开发](#扩展开发)
- [配置](#配置)
- [依赖安装与运行](#依赖安装与运行推荐使用-uv)
- [相关文档](#相关文档)

---

## 架构设计

```
主服务端 (Node.js)
    ↓ AgentRuntime.callSubserver
子服务端 (pyserver | goserver | phpserver | jserver | netserver)
    ├─ core/              底层（加载器、配置、命令注册）
    ├─ apis/system/       框架系统 API
    └─ apis/<group>/      示例或业务插件
```

与主仓 **`core/system-Core`** 分工相同：子服底层在 runtime 的 `core/`，业务在 `apis/<group>/`。

**主服融合**：配置见 [subserver-commonconfig.md](subserver-commonconfig.md)（主服编辑、`core/commonconfig/` 扫描）；`AgentRuntime.callSubserver` 用 `runtimeConfig.subserver`。

子服终端统一 **`子服>`** 提示符；顶栏支持 `帮助`/`列表`，组内支持 `状态`/`更新`。

> 历史上的 AI 业务接口已下线，不再属于当前子服务端官方能力。

## 现有 API

### GET /health

服务健康检查，返回 FastAPI 服务在线状态。

### GET /api/system/ping

返回底层服务存活信息。

**示例响应**：
```json
{
  "ok": true,
  "service": "subserver-core"
}
```

### GET /api/system/config

返回子服务端当前生效的基础配置（只读视图）。

**示例响应**：
```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8000,
    "reload": false
  },
  "api": {
    "prefix": "/api",
    "title": "XRK-AGT Python Subserver",
    "version": "1.0.0"
  }
}
```

## 扩展开发

子服务端通过 Loader 自动扫描 `apis/` 并装载导出 `default` 的模块（契约见 [`subserver/CONTRACT.md`](../subserver/CONTRACT.md)）。

**开发指南**：[subserver-plugin-development.md](subserver-plugin-development.md)

**学习用示例**：

- Python（HTTP + CommonConfig）：`subserver/pyserver/apis/media-tools/`
- Python（完整融合 + QQ）：`subserver/pyserver/apis/jmcomic/`
- Go：`subserver/goserver/apis/hash-tools/service.go`
- PHP：`subserver/phpserver/apis/string-tools/service.php`

最小 `default` 结构：
```python
from fastapi import Request

async def hello(_request: Request):
    return {"ok": True, "message": "hello"}

default = {
    "name": "demo-api",
    "description": "示例 API",
    "priority": 100,
    "routes": [
        {"method": "GET", "path": "/api/demo/hello", "handler": hello},
    ],
}
```

建议约定：
- 按业务分组目录：`apis/<group>/service.py`（或各语言等价文件）
- 业务逻辑放在 `apis/<group>/`，**不改动** `core/` 与加载器
- 接口前缀统一走 `/api/<group>/*`
- 扩展可自带 `requirements.txt`；启动时（`uv run python main.py`）扫描安装
- 第三方 / 产品插件本地 clone 到 `apis/<group>/`，不进主仓（见根 `.gitignore` 白名单）
- 业务扩展自带 README、默认配置与依赖；不写入 AGT 本体 `config/default_config/`

## 配置

### 配置文件位置

- **默认配置**：`subserver/pyserver/config/default_config.yaml`（模板）
- **用户配置**：`data/subserver/config.yaml`（运行时）

### 配置结构

```yaml
server:
  host: "0.0.0.0"
  port: 8000
  reload: false
  log_level: "info"

cors:
  origins: ["*"]

api:
  prefix: "/api"
  title: "XRK-AGT Python Subserver"
  version: "1.0.0"

logging:
  level: "info"
  file: "logs/subserver.log"
  max_bytes: 10485760
  backup_count: 5
```

## 依赖安装与运行

```bash
cd subserver/pyserver
uv sync
uv run python main.py
```

`apis/<组名>/requirements.txt` 在启动时安装；也可在子服终端执行「更新」。

环境变量示例：`HOST=0.0.0.0 PORT=8000 RELOAD=true uv run python main.py`

### 常见问题

| 现象 | 处理 |
|------|------|
| 端口被占用 | `PORT=8001 uv run python main.py` 或改 `data/subserver/config.yaml` |

## 相关文档

- **[AiWorkflow 文档](ai-workflow.md)** - Node 侧工作流与 LLM/MCP 调用说明
- **[Docker 部署指南](docker.md)** - 容器化部署说明
- **[框架可扩展性指南](框架可扩展性指南.md)** - 扩展开发完整指南

---

*最后更新：2026-08-10*
