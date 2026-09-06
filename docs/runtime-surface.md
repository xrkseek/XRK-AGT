# 运行时挂载面（开发者速查）

> **读者**：在 `core/` 写插件、API、工作流、Tasker 的开发者  
> **源码**：`src/agent-runtime.js`、`src/bootstrap-globals.js`、各 `src/infrastructure/*/loader.js`  
> **基类契约**：[base-classes.md](base-classes.md) · **Loader 模式**：[infrastructure-shared.md](infrastructure-shared.md)

本篇透明列出：**何时挂载、挂在哪里、业务代码怎么用**。不重复架构图（见 [底层架构设计.md](底层架构设计.md)）。

![运行时挂载面导读](../resources/mdimg/docs/runtime-surface.png)

---

## 全局标识符写法（必读）

运行时对象挂在 **`globalThis`**（Node 里与 `global` 同一对象）。业务模块里**直接写裸名**即可，ESLint 已声明 `AgentRuntime`、`msgSegment`、`logger`、`PluginBase`、`Renderer`（见根目录 `eslint.config.js`）。

| 场景 | 正确写法 | 不要写 |
|------|----------|--------|
| 插件 / Tasker / 事件 | `AgentRuntime`、`msgSegment`、`AgentRuntime.makeLog()` | `global.AgentRuntime`、`import AgentRuntime`、`new AgentRuntime()` |
| HTTP handler | `req.agentRuntime` 或 handler 第三参 `AgentRuntime` | `global.AgentRuntime`（除非无注入时的兜底，优先 `req.agentRuntime ?? AgentRuntime`） |
| 配置 | `import runtimeConfig from '#infrastructure/config/config.js'` | 无必要不写 `global.runtimeConfig`（与 import 同一单例） |
| 插件基类 | `import PluginBase from '#infrastructure/plugins/plugin-base.js'` | 新代码勿依赖 `global.PluginBase` |
| 消息段 | 裸名 `msgSegment.image(url)` | `global.msgSegment`；无需从别处 import |
| **仅** `src/` 挂载点 | `setRuntimeGlobal(name, value)`（`#utils/runtime-globals.js`） | 手写 `global.x = …; globalThis.x = …` 双份 |

**`core/` 业务**：裸名或 `import`。**`src/` 挂载**：`setRuntimeGlobal`（`#utils/runtime-globals.js`）。

配置在 `AgentRuntime.run` 完成 `CommonConfigRegistry.load()` **之前**不可用；此前请用 ConfigBase / 默认模板，勿假设 `runtimeConfig` 已就绪。

### 框架单测 / 集成测

`tests/helpers/bootstrap.mjs` 在 `describe(..., { before: bootstrapTestEnv })` 中：

1. 设置 `process.env.XRK_TEST = '1'`
2. **import `src/bootstrap-globals.js`**（与生产 `agent-runtime.js` 一致，挂载 `PluginBase` / `msgSegment`）
3. stub 最小 `AgentRuntime`（EventEmitter + `makeLog` / `tasker` / `em`）

未执行 bootstrap-globals 时，system-Core 插件（`extends PluginBase`）会在 PluginLoader 导入阶段报 `PluginBase is not defined`。HttpApiLoader 集成断言的 key 见 [api-loader.md](api-loader.md)（`resolveQualifiedCoreModuleKey`，如 `system-Core/ai-workspace`）。

---

## 挂载时间线

```mermaid
sequenceDiagram
  participant App as dist/app.js
  participant Boot as bootstrap-globals
  participant Start as start.js
  participant AgentRuntime as AgentRuntime.run
  participant Load as Loaders

  App->>Start: bootstrap → import start.js
  Note over Boot: agent-runtime.js 首行 import
  Boot->>Boot: globalThis.PluginBase / msgSegment
  Start->>AgentRuntime: setRuntimeGlobal('AgentRuntime')
  AgentRuntime->>Load: CommonConfigRegistry.load 完成并挂全局
  AgentRuntime->>Load: 再并行 Stream / Plugins / Api
  Note over Load: Tasker 注册 AgentRuntime.tasker / AgentRuntime.wsf
  Note over Load: stdin Tasker → setRuntimeGlobal('stdinHandler')
```

| 阶段 | 挂载 | 源码 | 业务写法 |
|------|------|------|----------|
| `agent-runtime.js` 模块加载 | `PluginBase`、`msgSegment` | `src/bootstrap-globals.js` | 裸名 `msgSegment`；基类 `import PluginBase from '…'` |
| `agent-runtime.js` constructor | HTTP 业务层方法、`callSubserver` 等 | `AgentRuntime._mountHttpBusinessMethods()`、`_initSubServer()` | `AgentRuntime.handleRedirect(req,res)` 等 |
| `start.js` / `TaskerLoader` | `AgentRuntime` | `start.js`、`tasker/loader.js` | 裸名 `AgentRuntime`，勿 `new AgentRuntime()` |
| `AgentRuntime.run` 配置阶段 | `runtimeConfig`、`CommonConfigRegistry` | **先** `CommonConfigRegistry.load()` 再其它 Loader | `import runtimeConfig` 或裸 `runtimeConfig`（配置阶段完成后） |
| 模块 side-effect | `Renderer`（基类） | `renderer/loader.js` 顶层 | 继承 `Renderer`；实例 `getRenderer()` |
| stdin Tasker 初始化 | `stdinHandler` | `core/system-Core/tasker/stdin.js` | 一般业务不直接碰 |
| `HttpApiLoader.register` | `req.agentRuntime`、`req.apiLoader` | `http/loader.js` 中间件 | handler 第三参或 `req.agentRuntime` |

---

## 全局对象

| 名称 | 类型 | 挂载时机 | 业务写法 |
|------|------|----------|----------|
| `AgentRuntime` | `AgentRuntime` 实例（Proxy） | 启动后 | 裸名 `AgentRuntime` |
| `runtimeConfig` | `RuntimeConfig` 实例 | `CommonConfigRegistry.load` 成功后 | `import runtimeConfig from '#infrastructure/config/config.js'` |
| `CommonConfigRegistry` | `CommonConfigRegistry` 单例 | 同上 | 一般 `import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js'`；热路径可用裸名 |
| `msgSegment` | 消息段工厂 | `bootstrap-globals` | 裸名 `msgSegment.image()` |
| `PluginBase` | 插件基类 | `bootstrap-globals` | 新代码 **import 基类**，勿靠 `global.PluginBase` |
| `Renderer` | 渲染器基类 | `renderer/loader.js` | 实现放 `src/renderers/<名>/` |
| `stdinHandler` | stdin Tasker 实例 | stdin Tasker `init` | 框架内部 |

### 事件对象上的 `e.bot`

**`e.bot`**（小写）是通道账号实例（OneBot/飞书等 Tasker 注入）。回消息、查 `uin`/`tasker` 用 `e.bot`；编排 HTTP、加载器与工具代理用全局裸名 `AgentRuntime`。

---

## `AgentRuntime` 实例面

`AgentRuntime` 是 **`Proxy(AgentRuntime)`**（`AgentRuntime._createProxy()`），解析顺序：

1. `AgentRuntime` 自身属性 / 方法  
2. `AgentRuntime.bots[self_id]` 子 AgentRuntime（Tasker 注册，如 `AgentRuntime['123456']`）  
3. **`RuntimeUtil` 静态成员**（如 `AgentRuntime.makeLog` → 实际 `RuntimeUtil.makeLog`）

### 常用属性

| 属性 | 说明 |
|------|------|
| `AgentRuntime.tasker` | Tasker 实例数组 |
| `AgentRuntime.wsf` | WebSocket 路径 → 处理函数 |
| `AgentRuntime.uin` | 已连接 QQ 号列表（带 `toJSON()` 随机选取） |
| `AgentRuntime.bots` / `AgentRuntime[self_id]` | 各平台子 AgentRuntime 对象 |
| `AgentRuntime.express` | Express 应用 |
| `AgentRuntime.httpBusiness` | `HTTPBusinessLayer` 实例 |
| `AgentRuntime.HttpApiLoader` | HttpApiLoader 类引用 |

### 常用方法（AgentRuntime 本体）

| 方法 | 说明 |
|------|------|
| `AgentRuntime.em(name, data, asJson?, options?)` | 触发事件总线；Tasker / 监听器 / 插件链路入口 |
| `AgentRuntime.callStdin(command, options?)` | 经 stdin Tasker 执行命令 |
| `AgentRuntime.getServerUrl()` | 当前 HTTP 基址（含 127.0.0.1 回落） |
| `AgentRuntime.getPublicServerUrl(override?)` | 对外直链基址（代理/`server.url`/override；无公网配置时返回 `''`） |
| `AgentRuntime.callRoute(path, options?)` | 内部调用已注册 API 路由 |
| `AgentRuntime.checkApiAuthorization(req)` | `/api/*` 鉴权（HttpApi 自动调用） |
| `AgentRuntime.makeError(msg, type?, details?)` | 标准化错误对象 |
| `AgentRuntime.run(options?)` | 启动入口（仅 `start.js` 调用） |

### 挂载自 HTTP 业务层（`_mountHttpBusinessMethods`）

配置加载后 `_reinitHttpBusiness()` 会重建并重新挂载：

| AgentRuntime 上的方法 | 委托自 |
|--------------|--------|
| `selectProxyUpstream(domain, algorithm, clientIP?)` | `httpBusiness.proxyManager` |
| `getProxyStats()` | `httpBusiness.proxyManager` |
| `isCDNRequest(req)` | `httpBusiness.cdnManager` |
| `setCDNHeaders(res, filePath, req)` | `httpBusiness.cdnManager` |
| `handleRedirect(req, res)` | `httpBusiness.redirectManager` |

### 挂载自子服务端（`_initSubServer`）

| 方法 | 说明 |
|------|------|
| `callSubserver(path, options?)` | 调 Python 子服务 `apis/` |
| `fetchSubserverToPath(path, options?)` | 拉取子服务文件到本地路径 |

### 经 Proxy 透传的 `RuntimeUtil`

业务里写 `AgentRuntime.makeLog(level, msg, tag)`、`AgentRuntime.sleep(ms)` 等与 `#utils/runtime-util.js` 静态方法等价。完整列表见 [runtime-util.md](runtime-util.md)。

---

## Loader 单例（import 即用）

| 单例 | import 路径 | 常用 API |
|------|-------------|----------|
| AiWorkflowLoader | `#infrastructure/ai-workflow/loader.js` | `getWorkflow(name)`、`getAllWorkflows()` |
| PluginLoader | `#infrastructure/plugins/loader.js` | `deal(e)`（框架内）；插件通过基类间接使用 |
| HttpApiLoader | `#infrastructure/http/loader.js` | `getApiList()`、`apis` Map（key = `resolveQualifiedCoreModuleKey`，如 `system-Core/ai-workspace`） |
| CommonConfigRegistry | `#infrastructure/commonconfig/loader.js` | `get(name)`、`getList()` |
| RendererLoader | `#infrastructure/renderer/loader.js` | `getRenderer(name?)`、`ensureLoaded()` |
| TaskerLoader | `#infrastructure/tasker/loader.js` | `load(bot)`（框架内） |
| ListenerLoader | `#infrastructure/listener/loader.js` | `load(bot)`（框架内） |
| `runtimeConfig` | `#infrastructure/config/config.js` | `runtimeConfig.server`、`getGlobalConfig`、`getServerConfig` |

插件基类已封装：`this.getWorkflow(name)` → `getAiWorkflowHost().getWorkflow(name)`（见 `plugin-base.js` + `workflow-host.js`）。

---

## 按场景的写法

### 插件（`core/*/plugin/` · `subserver/*/apis/*/core/plugin/`）

主服 `PluginLoader` 与 `CommonConfigRegistry` 等会同时扫描仓库根 `core/<Core>/` 与子服业务插件下的 `apis/<group>/core/`（见 `subserver/CONTRACT.md`）。

```javascript
import PluginBase from '#infrastructure/plugins/plugin-base.js';

export default class Demo extends PluginBase {
  constructor() {
    super({ name: 'demo', event: 'message', rule: [{ reg: /^#hi$/ }], handler: 'hi' });
  }
  async hi(e) {
    AgentRuntime.makeLog('info', 'hi', this.name);           // Proxy → RuntimeUtil
    const stream = this.getWorkflow('chat');          // → AiWorkflowLoader
    return this.reply('pong');                      // → e.reply / 事件回复链
  }
}
```

可用：`msgSegment`、`AgentRuntime`、`AgentRuntime[self_id]`；**不要** `new AgentRuntime()`。

### HTTP API（`core/*/http/`）

```javascript
import { HttpResponse } from '#utils/http-utils.js';

export default {
  name: 'demo-api',
  routes: [{
    method: 'GET',
    path: '/api/demo/ping',
    systemAuth: false,
    handler: async (req, res, AgentRuntime) => {
      return HttpResponse.success(res, { url: AgentRuntime.getServerUrl() });
    }
  }]
};
```

`req.agentRuntime` 与 handler 第三参 `AgentRuntime` 相同；`/api/*` 默认鉴权，公开路由设 `systemAuth: false`。

### AI 工作流（`core/*/workflow/`）

```javascript
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';

export default class MyStream extends AiWorkflow {
  constructor() {
    super({ name: 'my-stream', description: '...' });
  }
  async init() {
    await super.init();
    this.registerMCPTool('my_tool', { description: '...', inputSchema: {}, handler: async () => ({}) });
  }
}
```

### Tasker（`core/*/tasker/`）

模块加载时在顶层向 `AgentRuntime.tasker` 注册；可写 `AgentRuntime.wsf['/path'] = handler`。规范见 [tasker-base-spec.md](tasker-base-spec.md)。

### 事件监听（`core/*/events/`）

继承 `ListenerBase`，实现 `async init()`；Loader 注入 `this.bot`。见 [base-classes.md](base-classes.md#eventlistenerbaselistenerbasejs)。

---

## 勿做

- 在 `core/` 业务里 `new AgentRuntime()` 或改 `src/infrastructure/` 加载逻辑  
- 重复实现鉴权、`util.promisify(exec)`、`node-fetch`（见 [node-26-runtime.md](node-26-runtime.md)）  
- 在 constructor 里 `new Map()` 做插件/Loader 级缓存（用热重载安全的**类字段**）  
- 在 `core/` 写 `global.AgentRuntime` / `global.msgSegment` / `global.runtimeConfig`（用裸名或 import）  
- 在 `AgentRuntime.run` 配置加载完成前使用 `runtimeConfig`（此前用 ConfigBase / 默认模板）

---

## 相关文档

- [coding-style.md](coding-style.md) — 写法与性能速查  
- [base-classes.md](base-classes.md) — 各基类 export 形状  
- [bot.md](bot.md) — AgentRuntime 生命周期、HTTP/WS、关闭流程  
- [startup.md](startup.md) — 启动链  
- [config-base.md](config-base.md) — `runtimeConfig` 与 ConfigBase  

---

*最后更新：2026-06-14*
