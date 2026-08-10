# XRK-AGT 多语言子服务

主服 **Node.js** 负责 LLM / AiWorkflow / **全部配置管理（CommonConfig）**；子服务用其它语言做可插拔业务，**只读** `data/` 下运行时配置。

> 配置分工：[docs/subserver-commonconfig.md](../docs/subserver-commonconfig.md) · 插件开发：[docs/subserver-plugin-development.md](../docs/subserver-plugin-development.md)

| ID | 语言 | 端口 | 示例插件 |
|----|------|------|----------|
| `pyserver` | Python | 8000 | media-tools, doc-pipeline, web-fetch, jmcomic* |
| `goserver` | Go | 8001 | hash-tools |
| `phpserver` | PHP | 8002 | string-tools |
| `jserver` | Spring Boot | 8003 | datetime-tools, json-tools |
| `netserver` | ASP.NET Core | 8004 | uuid-tools |
| `rustserver` | Axum | 8005 | regex-tools |

\* `jmcomic` 本地 clone（gitignore）。**权威目录**（含路径/启动命令）：[`src/utils/subserver-runtimes.js`](../src/utils/subserver-runtimes.js)

选型说明：[`LANGUAGES.md`](LANGUAGES.md) · 运行时目录：[`src/utils/subserver-runtimes.js`](../src/utils/subserver-runtimes.js) · **开发指南**：[`docs/subserver-plugin-development.md`](../docs/subserver-plugin-development.md)

## 统一目录

与主仓 `core/system-Core` 同理：**子服底层在 runtime 的 `core/`，业务插件在 `apis/<组名>/`**。

业务插件若需与主服融合，在 **`apis/<组名>/core/`** 放置与主仓 Core 相同结构：`commonconfig/`（控制台）、`plugin/`（QQ）等。见 [docs/subserver-commonconfig.md](../docs/subserver-commonconfig.md)。

```
<subserver>/<runtime>/
  config/default_config.*     # 子服配置模板
  core/                       # 子服加载器、命令注册（底层）
  apis/
    system/                   # 框架系统 API
    <组名>/
      service.*               # 子服 HTTP/命令入口
      default_config.*        # 业务配置模板 → data/<组名>/
      core/                   # 主服 Core 扩展（与 core/system-Core 同结构）
        commonconfig/
        plugin/
```

新建插件：**复制同 runtime 已有示例**（如 pyserver 的 `media-tools`），改 `group` 与路由即可。

## 各 runtime 参考示例

| Runtime | 底层 | 学习用示例 |
|---------|------|------------|
| pyserver | `core/` · `apis/system/` | `apis/media-tools/`（HTTP+CommonConfig）；完整融合见 `apis/jmcomic/` |
| goserver | `core/` | `apis/hash-tools/service.go` |
| phpserver | `core/` | `apis/string-tools/service.php` |
| jserver | `core/` · `src/.../apis/` | `DatetimePlugin.java`（主服 `core/plugin` 需自建 `apis/<group>/core/`） |
| netserver | `Core/` · `Web/SystemEndpoints.cs` | `Apis/uuid-tools/UuidToolsPlugin.cs` |
| rustserver | `src/core/` · `src/plugins/` | `regex_tools.rs`（手动注册；主服扫描需 `apis/<group>/core/`） |

## 启动

详见 **[SETUP.md](SETUP.md)**。Docker：`pnpm docker:build` → `pnpm docker:up`（见 [docs/docker.md](../docs/docker.md)）。

```bash
cd subserver/pyserver && uv run python main.py   # 本机 Python 8000
```

## 主服务衔接

**子服务终端**（与主服 `>` 分离，统一提示符 `子服>`）

```text
子服> 帮助
子服> media-tools 状态
子服> @java datetime-tools 状态
```

各 runtime 底层对齐项：

| 能力 | pyserver | goserver | phpserver | jserver | netserver | rustserver |
|------|:--------:|:--------:|:---------:|:-------:|:---------:|:----------:|
| `/health` · `/api/system/*` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 主服扫描 `core/commonconfig` | ✅ | ✅* | ✅* | ⚠️ | ✅* | ⚠️ |
| `apis/<group>/` 自动扫描 | ✅ | 生成 import | ✅ | Spring 扫描 | 反射发现 | 手动注册 |
| stdin `子服>` + 中文别名 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**代码调用**

```javascript
await AgentRuntime.callSubserver('/api/json-tools/format', {
  runtime: 'jserver',
  method: 'POST',
  body: { text: '{"a":1}' }
})
```

配置：**CommonConfig → AiWorkflow → 子服务端**（`subserver.runtimes`）
