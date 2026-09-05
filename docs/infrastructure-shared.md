# 基础设施共享约定

> Loader / 全局引导的**单一说明**；**写法与性能**见 [coding-style.md](coding-style.md)。  
> 工具索引见 [runtime-surface.md](runtime-surface.md)；基类见 [base-classes.md](base-classes.md)。  
> **热重载已移除**：见 [ADR-0004](adr/0004-typescript-dist-no-hot-reload.md)。

各 Loader / 配置模块复用的工具与模式，**业务 Core 勿在此目录放码**。

## 工具模块（`src/utils/`）

| 模块 | 用途 |
|------|------|
| `runtime-globals.js` | `setRuntimeGlobal` / `getRuntimeGlobal`；`isShuttingDown` / `setShuttingDown`；`isProcessFlagSet` / `setProcessFlag` |
| `file-loader.js` | `importFresh`（带 cache-bust 的动态 import）、`forEachBatch` / `mapInBatches` |
| `loader-constants.js` | `LOADER_BATCH_SIZE`、`API_REGISTER_BATCH_SIZE` |
| `loader-shutdown.js` | 停机时 `stopAllLoaderWatchers()`（销毁 Plugins / Stream / Config / Renderer 等资源） |
| `token-estimate.js` | `estimateTokensRough` / `estimateTokensMixed` |
| `sse-openai.js` | `writeSSEChunk`、`createOpenAIChunk` |
| `module-ext.ts` | 模块扩展名约定、`moduleFileKey` / `preferSourceModules` |
| `core-fs.js` | `resolveCoreModuleKey` / `resolveQualifiedCoreModuleKey`（多 Core 防撞：`system-Core/admin`）；`scanFiles` |
| `string-array-utils.js` | 配置层字符串数组归一化 |

www 挂载（`src/infrastructure/http/`；权威文档 [www-mount.md](www-mount.md)）：

| 模块 | 用途 |
|------|------|
| `www-app-resolve.js` | 普通静态 vs 前端工程（sign）；URL / dist / proxy 决策 |
| `mount-core-www.js` | 挂载两类 www；proxy 跳过静态 |
| `frontend/launcher.js` | 仅拉起需反代的前端工程 |

引导、信号、路径等其余 `src/utils/` 模块见 [runtime-surface.md](runtime-surface.md)、[coding-style.md](coding-style.md)。

## 全局引导

- `src/bootstrap-globals.js`：在 `agent-runtime.js` 首行 import，`setRuntimeGlobal('PluginBase'|'msgSegment', …)`  
- 集成测试：`tests/helpers/bootstrap.mjs` 同样 import 一次，供 PluginLoader / HttpApiLoader 加载 `extends PluginBase` 模块  
- 业务：裸名 `msgSegment` / import 基类；见 [runtime-surface.md](runtime-surface.md)

## Loader 标准模式

1. 类字段存放缓存 Map（禁止在 constructor 里 new 可变容器）
2. 扫描：`FileLoader.getCoreSubDirFiles(subDir)` 或 `paths.getCoreDirs()`（**全量** `core/*` 目录；勿用 loader 子目录反推，否则仅有 `www` 的 Core 会漏挂静态）
3. 加载：`FileLoader.importFresh(absPath)` + `forEachBatch(..., LOADER_BATCH_SIZE, ...)`
4. **启动时加载一次**；改代码 / YAML / 模板后 **重启进程**（无 chokidar / `HotReloadBase`）
5. 模块 key 优先 `resolveQualifiedCoreModuleKey(file, dirs, subDir)`（如 `mongodb-Core/admin`），禁止仅 basename（多 Core 会互相覆盖）

**加载顺序**：`CommonConfigRegistry.load` → 挂载 `CommonConfigRegistry` → 再并行 Workflow / Plugins / Api（避免插件 init 读不到配置）。

## 文档入口

- 写法规范：[coding-style.md](coding-style.md)
- 运行时挂载：[runtime-surface.md](runtime-surface.md)
- HTTP API：[docs/http-api.md](http-api.md)
- 基类契约：[docs/base-classes.md](base-classes.md)
- TypeScript / dist：[ADR-0004](adr/0004-typescript-dist-no-hot-reload.md)
- 插件 / Tasker / 工作流：`.cursor/skills/xrk-*` 与 [docs/框架可扩展性指南.md](框架可扩展性指南.md)

---

*最后更新：2026-09-05*
