# 业务扩展基类契约

> **源码**：`src/infrastructure/` 各基类文件  
> **读者**：在 `core/` 新建插件 / API / 工作流 / 配置 / 事件监听器的开发者  
> **挂载与全局**：完整表格见 **[runtime-surface.md](runtime-surface.md)**（AgentRuntime Proxy、`req.agentRuntime`、Loader 单例）  
> **Loader 模式**：[infrastructure-shared.md](infrastructure-shared.md)

以下仅为**最小 export 形状**；规则匹配、MCP、鉴权等细节见各 L2 专题。

---

## PluginBase（`plugins/plugin-base.js`）

| 项 | 说明 |
|----|------|
| 放置 | `core/<名>/plugin/*.js` 或 `subserver/*/apis/<group>/core/plugin/*.js` |
| 继承 | `import PluginBase from '#infrastructure/plugins/plugin-base.js'` |
| 实例 API | `getWorkflow`、`reply`、`setContext` / `getContext` / `finish`、`getInfo()`（见 [plugin-base.md](plugin-base.md)） |

```javascript
export default class MyPlugin extends PluginBase {
  constructor() {
    super({
      name: 'my-plugin',
      event: 'message',
      priority: 5000,
      rule: [{ reg: /^#命令/ }],
      handler: 'run',
    });
  }
  async run(e) { /* AgentRuntime / msgSegment / this.getWorkflow 见 runtime-surface */ }
}
```

Enhancer → `plugins/enhancer-base.js`。资源释放 → `async destroy()`。

---

## HttpApi（`http/http.js`）

| 项 | 说明 |
|----|------|
| 放置 | `core/<名>/http/*.js` |
| 推荐 | **对象导出**（HttpApiLoader 包装为 HttpApi） |
| 注入 | handler `(req, res, AgentRuntime)` 与 `req.agentRuntime` 等价 |

```javascript
import { HttpResponse } from '#utils/http-utils.js';

export default {
  name: 'my-api',
  priority: 100,
  routes: [{
    method: 'GET',
    path: '/api/foo',
    handler: async (req, res, AgentRuntime) => HttpResponse.success(res, {}),
  }],
};
```

`/api/*` 默认 `systemAuth: true`；公开设 `systemAuth: false`。

---

## AiWorkflow（`ai-workflow/ai-workflow.js`）

| 项 | 说明 |
|----|------|
| 放置 | `core/<名>/workflow/*.js` |
| 加载 | AiWorkflowLoader 单例 → `getWorkflow(name)` |
| 业务扩展 | 重写 `patchLLMConfig(merged, apiConfig)` 追加场景字段；request body 由各 `*LLMClient.buildBody` 按官方文档组装 |
| 厂商协议 | `openai_llm` / `deepseek_llm` 等 **builtin** 独立客户端；`openai_compat_llm` 仅用于第三方 OpenAI 形态网关 |
| 组合进 Agent | AI 助手或调用方 `process({ mergeWorkflows: ['my-stream'] })`；工具名 `my-stream.tool` |
| 框架工具面 | 构造可选 `frameworkToolSurface: true` → 自动进 chat MCP 白名单（无需 merge）；可选 `capabilities: ['tools','prompt']` |
| 联动插件 | stream MCP 可代发指令走 `PluginLoader.deal`；会话 `e` 优先 ALS（`runWithWorkflowRequestContext`） |

```javascript
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';

export default class MyStream extends AiWorkflow {
  constructor() {
    super({
      name: 'my-stream',
      description: '...',
      capabilities: ['tools'],
      // frameworkToolSurface: true, // 需要始终暴露给 chat 时再开
    });
  }
  async init() {
    await super.init();
    this.registerMCPTool('tool_name', { description, inputSchema, handler });
  }
  buildSystemPrompt() {
    return '用户需要某某能力时调用 my-stream.tool_name。';
  }
  async cleanup() { /* 热重载/停机 */ }
}
```

---

## ConfigBase（`commonconfig/commonconfig.js`）

**配置管理全在主服**；子服业务插件通过 `core/commonconfig/*.js` 接入同一套控制台（见 [subserver-commonconfig.md](subserver-commonconfig.md)）。

| 项 | 说明 |
|----|------|
| 主仓 Core | `core/<名>/commonconfig/*.js` |
| 子服业务插件 | `subserver/*/apis/<group>/core/commonconfig/*.js` |
| 运行时数据 | `data/<group>/config.yaml`（主服 write，子服只读） |
| 子服连接 | `ai-workflow.yaml` → `runtimeConfig.subserver`（非业务 yaml） |

```javascript
export default class MyConfig extends ConfigBase {
  constructor() {
    super({
      name: 'mygroup',
      displayName: '显示名',
      filePath: 'data/mygroup/config.yaml',
      defaultTemplatePath: 'subserver/pyserver/apis/mygroup/default_config.yaml',
      schema: { fields: { /* ... */ } },
    });
  }
}
```

---

## ListenerBase（`listener/base.js`）

| 项 | 说明 |
|----|------|
| 放置 | `core/<名>/events/*.js` |
| 生命周期 | Loader `new` 后调用 `async init()`；注入 `this.bot` |
| 契约 | `super('短名')`；订阅读 `{短名}.message|notice|request`；`markTasker` → `plugins.deal` |

```javascript
export default class MyEvent extends ListenerBase {
  constructor() { super('mycore'); }
  async init() {
    const bot = this.bot || AgentRuntime
    bot.on('mycore.message', (e) => this.handle(e))
  }
  async handle(e) {
    if (!this.markProcessed(e)) return
    this.markTasker(e)
    await this.plugins.deal(e)
  }
}
```

匹配与命名见 [事件系统标准化文档.md](事件系统标准化文档.md) · `#utils/event-keys.js`。

---

## Tasker

可选 `TaskerBase`（`tasker/tasker-base.js`）：`createEvent` / `emitEvent(短名, e, bot)`。  
模块内 `AgentRuntime.tasker.push(...)`、`AgentRuntime.wsf[path]`。派发须 `em('{短名}.{post_type}', e)` 且 `e.tasker` 为字符串。见 [tasker-base-spec.md](tasker-base-spec.md) · skill **`xrk-tasker`**。

---

## 相关文档

- [runtime-surface.md](runtime-surface.md) — 全局 / AgentRuntime 挂载面  
- [框架可扩展性指南.md](框架可扩展性指南.md) — Core 目录与扩展点  
- [DOCSTYLE.md](DOCSTYLE.md) — 文档编写规范  

---

*最后更新：2026-07-02*
