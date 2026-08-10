# 底层与 Core 写法规范

> **读者**：在 `core/`、`src/infrastructure/`、`src/utils/` 写代码的开发者与 AI  
> **关联**：[runtime-surface.md](runtime-surface.md) · [node-26-runtime.md](node-26-runtime.md) · [infrastructure-shared.md](infrastructure-shared.md)  
> **规则副本**：`.cursor/rules/xrk-dev-requirements.mdc` · skill **`xrk-coding-style`**

**原则**：少分配、少同步 I/O、少重复封装；能复用底层工具就不在业务里再写一遍。

---

## 速查表

| 主题 | ✅ 要 | ❌ 不要 |
|------|--------|---------|
| 放码 | 业务 `core/<名>/`；基类/Loader `src/` | 业务写进 `src/`；改 Loader 逻辑应付业务 |
| 全局 | 裸名 `AgentRuntime`、`msgSegment`；HTTP 用 `req.agentRuntime` | `global.AgentRuntime`；`import AgentRuntime`；`new AgentRuntime()` |
| 基类 | `import PluginBase` / `HttpApi` / `AiWorkflow` | 依赖 `global.PluginBase` 写新插件（勿裸靠全局写新基类） |
| 配置 | `import runtimeConfig from '#infrastructure/config/config.js'` | 无必要写 `global.runtimeConfig` |
| 状态 | **类字段** `cache = new Map()` 或 `init()` 一次初始化 | constructor 里 `this.cache = new Map()` |
| 出站 HTTP | **服务端** `fetch` + `AbortSignal.timeout`；**浏览器** `abortTimeout`（`/xrk` 用 `./web-compat.js`，产品页内联） | `node-fetch`；www 裸 `AbortSignal.timeout`；产品页依赖 `/shared` |
| Shell | `#utils/exec-async.js` 的 `exec` | 各文件 `promisify(exec)` |
| 判错 | `Error.isError` / `normalizeError` | `instanceof Error` |
| 二进制 | `buf.toBase64()` / `Uint8Array.fromBase64` | `toString('base64')` 新代码 |
| 日志 | `RuntimeUtil.makeLog` 或裸 `AgentRuntime.makeLog` | `console.log` 持久化路径 |
| HTTP 响应 | `HttpResponse.success/error/asyncHandler`；前端 `unwrapSuccess` 或读顶层 | handler 裸 `res.json()`；前端默认 `json.data.字段` |
| Core www | `www/<app>/` + skill **`xrk-www-compat`**（`web-compat.js` / 内联垫片） | 裸用 Node 26 API |
| 热路径 I/O | `fs/promises`；`try/catch` 代替反复 `existsSync` | 请求链路里 `readFileSync` / 循环 `existsSync` |
| 批量加载 | `FileLoader.forEachBatch` + `LOADER_BATCH_SIZE` | 全量 `Promise.all(上千 import)` |
| Map 默认 | `map.getOrInsert(k, () => v)` | `get \|\| set` 样板（可写时） |
| 热重载 | `HotReloadBase`（`#utils/hot-reload-base.js`） | 业务/Loader 直接 `chokidar`；仅用 basename 重载多 Core 同名文件 |
| 挂载 | `setRuntimeGlobal`（`#utils/runtime-globals.js`） | `global.x = globalThis.x =` 双写 |

Node 26 API 明细与审查清单见 [node-26-runtime.md](node-26-runtime.md)、skill **`xrk-node-runtime`**。  
Core www / WebView 见 skill **`xrk-www-compat`**、[app-dev.md](app-dev.md)「Core www」节。

---

## 1. 分层

| 层 | 路径 | 写什么 |
|----|------|--------|
| Core | `core/<名>/plugin|http|stream|tasker|events|commonconfig|www/` | 业务 |
| Infrastructure | `src/infrastructure/`、`src/utils/`、`src/factory/` | Loader、基类、工厂、工具 |
| Runtime | `src/agent-runtime.js`、`start.js` | 启动、中间件、挂载 |

独立产品 Core 配置：`core/<名>/default/*.yaml` + `data/<产品>/`（见 `xrk-project` 规则）。勿把业务 yaml 放进 `config/default_config/`。

### 1.1 Core www（浏览器兼容层）

- 环境：校园 WebView、HTTP 非安全上下文；超时 / ID / 克隆用兼容层导出（`abortTimeout` / `randomId` / `deepClone`）。
- 标准垫片语义：`core/system-Core/www/xrk/modules/web-compat.js`。**仅 `/xrk` 相对导入**；其它产品页**只内联**。
- 根名 `shared` 保留（`RESERVED_ROOT_SEGMENTS`）；产品用自有目录名（如 `lsy-shared`）。
- `HttpResponse.success` 对普通对象**拍平**；前端 `unwrapSuccess` 或读顶层。
- 权威 skill：**`xrk-www-compat`**。

---

## 2. 全局与 import

```javascript
// 插件 / Tasker / 事件（须带 tasker 短名前缀；裸 message 无 Listener 进插件链）
AgentRuntime.em('onebot.message', { ...data, tasker: 'onebot' });
msgSegment.image(url);

// HTTP
handler: async (req, res, AgentRuntime) => HttpResponse.success(res, { url: AgentRuntime.getServerUrl() });

// 配置（与 globalThis.runtimeConfig 同一单例）
import runtimeConfig from '#infrastructure/config/config.js';
```

| 包 | `#` 别名 | 相对路径到 `src/` |
|----|----------|-------------------|
| 根仓库 | ✅ `#utils/*` `#infrastructure/*` | — |
| 有 `package.json` 的子 Core | ❌ | `../../../src/infrastructure/...` |

`AgentRuntime.run` 完成 `CommonConfigRegistry.load()` **之前**勿读 `runtimeConfig`；此前用 ConfigBase / 默认模板。

### 基础设施例外（仅 `src/`）

| 模式 | 用途 |
|------|------|
| `isShuttingDown()` / `setShuttingDown()` / `isProcessFlagSet()` / `setProcessFlag()`（`#utils/runtime-globals.js`） | 进程 shutdown / 信号一次性标志 |
| `global.selectedQQ` | 菜单进程标题 |
| `global.gc()` | 渲染器 debug 手动 GC |
| `console.log` + `chalk` | 启动横幅（非 pino 日志） |
| 冷路径 `existsSync` | 配置种子、Loader 首次扫描 |

业务运行时对象须 `setRuntimeGlobal`；读取用 `import` / 裸名 / `getRuntimeGlobal`。

---

## 3. 类、状态、热重载

```javascript
export default class Demo extends PluginBase {
  // ✅ 类字段：热重载安全
  cooldown = new Map();

  constructor() {
    super({ name: 'demo', event: 'message', rule: [{ reg: /^#x$/, fnc: 'run' }] });
    // ❌ 禁止：this.cache = new Map();
  }

  async init() {
    // 一次性昂贵初始化放这里
  }
}
```

插件 `super({ priority })` 控制顺序（**数字越小越先**）；`rule[]` **无** `priority` 字段。

---

## 4. 异步与并发

**Loader / 扫描**：批处理 + 失败隔离。

```javascript
await FileLoader.forEachBatch(files, LOADER_BATCH_SIZE, async ({ filePath }) => {
  const mod = await FileLoader.importFresh(filePath);
  // ...
});
// 并行多 Loader：Promise.allSettled（见 agent-runtime.js 启动段）
```

**业务**：

- 无依赖的多路 I/O 用 `Promise.all` / `allSettled`，勿串行 `await` 叠延迟。
- 限流/冷却用 Map + 时间戳，勿在 tight loop 里 `await sleep(0)` 刷队列。
- 流式 LLM/SSE：复用 `#utils/sse-openai.js`，边读边写，勿整段 `buffer` 再发。

**超时**：统一 `AbortSignal.timeout(ms)`，一处超时一处 signal。

---

## 5. I/O 与内存（性能）

| 场景 | 写法 |
|------|------|
| 启动 / 种子 / 菜单 | 同步 `fs` 可接受（`config-seed.js`、`start.js`） |
| HTTP / 插件 / 工作流热路径 | `import fs from 'node:fs/promises'` |
| 文件是否存在 | 优先 `try { await fs.access } catch` 或一次 `stat`，避免热路径 `existsSync` |
| 大 JSON/YAML | 读一次缓存到实例/模块级；Config 走 `runtimeConfig` 内存层 |
| 图片/下载 | `fetch` + `Readable.fromWeb` + `pipeline`（见 `subserver-client.js`） |
| 字符串拼接 | 长文本用数组 `push` + `join`，避免 `+=` 循环 |
| 正则 | 模块顶层的 `/…/g` 注意 `lastIndex`；或改用 `matchAll` / 非全局 |

---

## 6. 错误与日志

```javascript
import { normalizeError } from '#utils/normalize-error.js';

try {
  await work();
} catch (err) {
  const error = normalizeError(err);
  RuntimeUtil.makeLog('error', error.message, 'MyModule');
  throw error; // HTTP 层交给 HttpResponse.asyncHandler
}
```

- 用户可见错误：短句 + 上下文 tag；栈仅 debug/trace。
- 不吞错：`catch {}` 仅允许明确标注的降级点（如 optional 子服务）。

---

## 7. HTTP

```javascript
import { HttpResponse } from '#utils/http-utils.js';

export default {
  routes: [{
    method: 'GET',
    path: '/api/demo/ping',
    systemAuth: false, // 默认 true：/api/* 需 Key
    handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return HttpResponse.success(res, await resp.json());
    }, 'demo.ping')
  }]
};
```

- 路径参数、body：用 `InputValidator`（见 `http-api.md`）。
- 鉴权：框架已做 `checkApiAuthorization`；handler **不**重复比 Key。
- 兼容端点需原样 JSON 体时：`HttpResponse.json(res, body)`（如 `/api/stdin/command`）。

---

## 8. Loader 扩展（摘要）

完整模式见 [infrastructure-shared.md](infrastructure-shared.md)：

1. 类字段存 watcher / Map  
2. `FileLoader.getCoreSubDirFiles(subDir)` 扫描  
3. `importFresh` + `forEachBatch`  
4. `HotReloadBase` 监听；`stop()` 随 shutdown。内容 hash 去重、unlink 延迟确认见 [infrastructure-shared.md](infrastructure-shared.md)

挂载面见 [runtime-surface.md](runtime-surface.md)。

---

## 9. 命名

| 类型 | 风格 | 示例 |
|------|------|------|
| 插件 / 工作流 / Tasker 类 | PascalCase | `MyPlugin` |
| HTTP / 配置文件 | kebab-case | `my-api.js`、`my-config.yaml` |
| 日志 tag | 短横线或中文模块名 | `'MyStream'`、`'配置API'` |

---

## 审查（改 Core 前 30 秒）

- [ ] 无 `global.` 前缀（业务裸名或 import）  
- [ ] 无 constructor 可变容器  
- [ ] 无 `node-fetch` / 分散 `promisify(exec)` / `instanceof Error`  
- [ ] HTTP 用 `HttpResponse` + 服务端超时 `fetch`；www 用 `unwrapSuccess` / `abortTimeout`  
- [ ] 改 `www/` 对照 skill **`xrk-www-compat`**  
- [ ] 配置三件套已同步（若改字段）  
- [ ] 与 [代码审查清单.md](代码审查清单.md) 架构节一致  

---

## 相关文档

- [runtime-surface.md](runtime-surface.md) — 挂载与 AgentRuntime Proxy  
- [node-26-runtime.md](node-26-runtime.md) — Node API  
- [app-dev.md](app-dev.md) — 控制台与 Core www 兼容
- [base-classes.md](base-classes.md) — export 形状  
- [http-api.md](http-api.md) — 路由与鉴权  
- [代码审查清单.md](代码审查清单.md) — 发布前  

---

*最后更新：2026-07-17*
