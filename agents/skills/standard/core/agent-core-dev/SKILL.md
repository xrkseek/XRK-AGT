---
name: agent-core-dev
description: 工作区 Core 全场景写法（PluginBase/HTTP/AiWorkflow+MCP/events/commonconfig、多轮、定时、权限、notice/request）：写插件、工作流或任意 Core 扩展时加载
---

> 读者：办事助手。只写 `core/workspace-Core/`。  
> 常驻 rules / microagent 够用则 **直接 write**；本文件 = 全场景字段与配方。  
> 项目根相对工作区：`../../../`。  
> **读底层合法**：配方不够、字段/模式吃不准时，可读 `.cursor/skills/xrk-*`、`docs/`、`core/system-Core/` 示例，必要时读 `src/`——只读，不改。别为简单命令先扫一遍底层。

---

## 0. 场景 → 落点（先查这张表）

| 用户意图（例） | 写哪里 | 关键模式 |
|----------------|--------|----------|
| `#命令` / 关键词回复 | `plugin/` | `event:'message'`（跨 Tasker）+ `rule` + `fnc` |
| 仅群 / 仅私聊 | `plugin/` | `event:'message.group'` 或 `message.private` |
| 仅某一通道（如 QQ） | `plugin/` | `event:'onebot.message'`（定 Tasker，不进 device/stdin） |
| 仅主人可调 | `plugin/` | `rule[].permission:'master'` |
| 多轮问答（先问再收） | `plugin/` | `setContext` / `getContext` / `finish` |
| 定时任务 | `plugin/` | `task:[{ cron, fnc }]` + `init` 可空 |
| 通知（进群/退群/戳一戳/点赞…） | `plugin/` | `event:'notice…'` + **`accept()`**（`rule` 常 `[]`） |
| 好友/加群请求 | `plugin/` | `event:'request…'` + `accept` 或 rule |
| 调已有 AI 工作流 | `plugin/` | `this.getWorkflow('chat').process(...)`（§1.9 / §3.4） |
| HTTP CRUD / webhook | `http/` | `routes` + `HttpResponse` |
| 自定义 MCP 工具给模型 | `workflow/` | `AiWorkflow` + `registerMCPTool`（§3.2） |
| 挂载第三方远程 MCP | `workflow/` + **`getMcpServers`（优先）** | §0.1 / §3.5；**勿改**系统 yaml |
| 控制台配置项 | `commonconfig/` | `ConfigBase` + schema |
| 通道级监听 | `events/` | `ListenerBase`（少用） |
| 静态页 | `www/<应用名>/` | 静态资源；勿用保留根名 |
| 协议入站 | `tasker/` + `events/` | **默认不写**；须 `em('{短名}.message')` + `e.tasker` 字符串 |

热加载：改已有 `plugin|http|workflow/…` 下 `.js` 通常即可；**新建** `workflow/` 目录或新建 Core 名 → 重启 / `#重启`。

### 0.1 工作流 / MCP 决策（先判再写）

用户丢来 Cursor 式 `{ "mcpServers": { "某名": { "url"|"command"… } } }`，或说「挂/接/加个 MCP」：

| 判断 | 落盘 | 禁止 |
|------|------|------|
| 第三方远程（有 `url` / `command`） | `workflow/<短名>-mcp.js`：`export default` 占位流 + **`export function getMcpServers()`** 原样映射 | 改 `ai-workflow.yaml`；`registerMCPTool`+`fetch` 空壳 |
| 自研工具（本仓写逻辑） | `workflow/` + `registerMCPTool` | 伪装成 remote |
| 只要 `#命令` 调已有 chat | `plugin/` + `getWorkflow('chat').process` | 无故新开空 workflow |
| 用户**明确**要改控制台远程列表 | 口述 yaml 片段（`mcp.remote`）；你通常写不进系统配置 | 在工作区伪造系统 yaml |

**默认 JS 挂载**，少动配置，避免写坏运行时。

---

## 1. PluginBase

### 1.1 `super({...})`

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` / `dsc` | string | 标识与描述 |
| `event` | string | 见 §1.3；默认 `'message'` |
| `priority` | number \| `'extended'` | 越小越先；工作区自定义建议 ≥ 5000；`'extended'`=扩展队列 |
| `rule` | array | §1.2；notice 常 `[]` |
| `task` | array | `{ name?, cron, fnc, log? }` Cron |
| `handler` | array/object | 默认消息处理器（少用） |
| `eventSubscribe` | array/object | 自定义事件订阅 |
| `bypassThrottle` | boolean | 绕过节流 |
| `namespace` | string | 与 handler 配合 |

- 导出：`export class X extends PluginBase`（可多类）。可选 `async init()` / `async destroy()`。  
- 缓存用**类字段**；禁止 constructor 里 `this.x = new Map()`。  
- **plugin 模块**只 export 插件类，勿顺带 export 工具函数（Loader 会当插件实例化）。  
- **workflow 例外**：除 `export default` 的 AiWorkflow 外，允许 **`export function getMcpServers`**（见 §3.5）；勿 export 其它杂项。

### 1.2 `rule[]`

| 字段 | 说明 |
|------|------|
| `reg` | 对 `e.msg`：string / RegExp |
| `fnc` | 方法名 |
| `event` | 可选再滤子事件 |
| `permission` | `master` / `owner` / `admin` / `all` |
| `log` | 默认 true |

返回：`false`=未处理（同优先级继续）；其它=已处理。

### 1.3 `event` 键

Loader 经 `#utils/event-keys.js` → `matchPluginEvent`：可匹配键含 `{tasker}.{post}.{detail?}.{sub?}` 与跨 Tasker 的 `post` / `post.detail`。定 Tasker 订阅（首段非 `message|notice|request|meta|command`）**必须**与当前 `e.tasker` 一致。

| 场景 | 示例 |
|------|------|
| 任意消息（全通道） | `message` |
| 仅群 / 仅私 | `message.group` / `message.private` |
| 通知总类 | `notice`（再在 `accept` 里看 `sub_type`） |
| 具体通知 | `notice.group.increase` · `notice.*.poke` · … |
| 请求 | `request` · `request.friend` · `request.group` |
| 定 Tasker（防串台） | `onebot.message` / `device.*`（控制台 Event=device，勿用 onebot 前缀绑日志类命令除非只要 QQ） |

### 1.4 `this.e` / API（常用）

| 成员 | 用途 |
|------|------|
| `e.msg` / `e.user_id` / `e.group_id` / `e.self_id` | 文本与 ID |
| `e.isGroup` / `e.isMaster` | 场景与主人 |
| `e.operator_id` / `e.target_id` / `e.sub_type` / `e.notice_type` | notice/request |
| `this.reply(msg, quote?, data?)` | 回复；`data.recallMsg` 秒后撤 |
| `accept()` | `false` 跳过；`'return'` 截断链 |
| `setContext` / `getContext` / `finish` | 多轮 |
| `getWorkflow(name)` | 工作流 |

段消息：裸名 `msgSegment.text` / `image` / …（勿 `global.msgSegment`）。

### 1.5 配方 — message 命令

```js
export class MyCmd extends PluginBase {
  constructor() {
    super({
      name: '我的命令', dsc: '#我的命令', event: 'message', priority: 5000,
      rule: [{ reg: '^#我的命令\\s*(.*)$', fnc: 'run' }],
    });
  }
  async run() {
    try {
      await this.reply(this.e?.msg || 'ok');
    } catch (err) {
      const { normalizeError } = await import('#utils/normalize-error.js');
      await this.reply(`失败：${normalizeError(err).message}`);
    }
  }
}
```

主人命令：`rule` 加 `permission: 'master'`。

### 1.6 配方 — 多轮上下文

```js
export class AskThenSave extends PluginBase {
  constructor() {
    super({
      name: '问答收集', event: 'message', priority: 5000,
      rule: [
        { reg: '^#开始收集$', fnc: 'start' },
        { reg: '^[\\s\\S]+$', fnc: 'onInput' }, // 宽匹配；靠 context 门闩
      ],
    });
  }
  async start() {
    this.setContext('waitingInput', !!this.e.isGroup, 120, '已超时取消');
    await this.reply('请发送内容：');
  }
  async onInput() {
    if (!this.getContext('waitingInput')) return false;
    await this.reply(`已收到：${this.e.msg}`);
    this.finish('waitingInput', !!this.e.isGroup);
  }
}
```

宽 `reg` 必须用 context 判断，避免误吃所有消息。

### 1.7 配方 — 定时 `task`

```js
export class HourlyPing extends PluginBase {
  constructor() {
    super({
      name: '整点提醒', event: 'message', priority: 9000, rule: [],
      task: [{ name: 'hourly', cron: '0 0 * * * *', fnc: 'tick', log: true }],
    });
  }
  async tick() {
    // 无 this.e；用 AgentRuntime.sendMasterMsg 等主动出口（裸名）
  }
}
```

### 1.8 配方 — notice + `accept()`（通式）

```js
export class OnNotice extends PluginBase {
  constructor() {
    super({
      name: '通知处理',
      event: 'notice', // 或更具体：notice.group.increase / notice.*.poke
      priority: 5000,
      rule: [],
    });
  }
  async accept() {
    const e = this.e;
    if (!e || e.post_type !== 'notice') return false;
    // 按 e.notice_type / e.sub_type 分支；不匹配 return false
    // 做事……
    return 'return';
  }
}
```

示例（被戳且目标是机器人再动作）——**仅示例**：

```js
// event: 'notice.*.poke'；accept 内：
if (e.sub_type !== 'poke') return false;
if (String(e.target_id) !== String(e.self_id)) return false;
if (e.group?.pokeMember) await e.group.pokeMember(e.operator_id);
else if (e.friend?.poke) await e.friend.poke();
return 'return';
```

### 1.9 配方 — 调 chat 工作流

```js
async askAi() {
  const stream = this.getWorkflow('chat');
  if (!stream) return this.reply('chat 未加载');
  await stream.process(this.e, this.e.msg, { enableTools: true });
  // process 内通常已回复，插件不必再 reply
}
```

### 1.10 Enhancer

工作区优先普通 PluginBase。要对齐增强器只读 `../../../core/system-Core/plugin/OneBotEnhancer.js`。

---

## 2. HTTP

路径：`core/workspace-Core/http/<名>.js`

| 项 | 约定 |
|----|------|
| 导出 | `export default { name?, priority?, routes }` |
| route | `method` · `path` · `handler` · `systemAuth?` · middleware? |
| 运行时 | `req.agentRuntime` / 第三参；勿 `global.AgentRuntime` |
| `/api/*` | 默认鉴权；公开设 `systemAuth: false` |

### `HttpResponse.success`

| 第二参 | JSON |
|--------|------|
| 普通对象 | 拍平到顶层 |
| 数组/标量 | 进 `data` |
| `null` | 仅 success+message |

```js
import { HttpResponse } from '#utils/http-utils.js';

export default {
  name: 'workspace-api',
  routes: [
    {
      method: 'GET',
      path: '/api/workspace/ping',
      systemAuth: false,
      handler: HttpResponse.asyncHandler(async (req, res) => {
        return HttpResponse.success(res, { ok: true });
      }, 'ws-ping'),
    },
    {
      method: 'POST',
      path: '/api/workspace/echo',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const text = req.body?.text;
        if (text == null || text === '') {
          return HttpResponse.validationError(res, '缺少 text');
        }
        return HttpResponse.success(res, { text });
      }, 'ws-echo'),
    },
  ],
};
```

还有：`error` / `notFound` / `unauthorized` / `forbidden`。出站：`fetch(url, { signal: AbortSignal.timeout(ms) })`。

---

## 3. AiWorkflow（工作流 + MCP）

路径：`core/workspace-Core/workflow/<名>.js`（文件名建议与 `name` 一致）。  
办公优先现成 `tools` / `web` / `memory`…（见 **agent-tools**）；**只有要新工具面或独立对话流时才写**。

工具调用链路（现行）：**LLM tool calling + MCP**，无文本 ReAct。工作流里 `registerMCPTool` → 进入该流的工具表 → 模型按 schema 调用 → `handler` 执行。

### 3.1 `super({...})` 常用字段

| 字段 | 说明 |
|------|------|
| `name` | 流名（合并 / 控制台 / MCP 分组用这个字符串） |
| `description` / `version` / `author` / `priority` | 元信息；priority 越小越先 |
| `config` | 默认 LLM 覆盖（如 `temperature`、`maxTokens`、`enabled`） |
| `capabilities` | 标签数组（如 `['tools']`），供能力面识别 |
| `frameworkToolSurface` | `true` 时：开放模式下 chat 自动并入本流工具（不必每次 `mergeWorkflows`） |
| `embedding` | `{ enabled: true }` 等；多数工具面可省略 |
| `functionToggles` | `{ tool_name: false }` 覆盖单工具 enabled |

### 3.2 最小完整配方（注册 MCP 工具）

```js
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';

export default class MyStream extends AiWorkflow {
  constructor() {
    super({
      name: 'my-stream',
      description: '工作区示例工具面',
      version: '1.0.0',
      priority: 5000,
      capabilities: ['tools'],
      // 希望办事助手 / 开放 chat 自动带上这些工具时打开：
      // frameworkToolSurface: true,
      config: { enabled: true, temperature: 0.7, maxTokens: 2000 },
    });
  }

  async init() {
    await super.init();
    this.registerMCPTool('echo_text', {
      description: '原样回显文本（示例）。参数 text 必填。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要回显的内容' },
        },
        required: ['text'],
      },
      handler: async (args = {}, context = {}) => {
        const text = String(args.text ?? '').trim();
        if (!text) return this.errorResponse('INVALID_ARGS', 'text 不能为空');
        return this.successResponse({ echo: text });
      },
      enabled: true,
    });
  }

  /** 作为主流对话时注入；纯工具面可只写一句「何时调哪些工具」 */
  buildSystemPrompt() {
    return '需要回显时调用工具 echo_text（工作流 my-stream）。';
  }

  async cleanup() {}
}
```

`registerMCPTool(name, options)`：

| 字段 | 说明 |
|------|------|
| `description` | 给模型看；写清用途与边界 |
| `inputSchema` | JSON Schema（`type`/`properties`/`required`） |
| `handler` | `async (args, context) => …`；`context` 可含用户/场景信息 |
| `enabled` | 可被 `functionToggles` 覆盖 |

返回值优先基类：

- `this.successResponse(data)` → `{ success: true, data: { …, timestamp } }`
- `this.errorResponse(code, message)` → `{ success: false, error: { code, message } }`

可选覆写 `buildChatContext(e, question)`（自定义 system/user 消息）；多数工具面不需要。

### 3.3 何时写 workflow vs 只写 plugin

| 需求 | 做法 |
|------|------|
| `#命令` 里调已有 chat/memory | plugin：`getWorkflow('chat').process(...)` |
| 给模型一个**新可调用工具** | workflow + `registerMCPTool` |
| 独立对话人设 + 自有工具 | workflow 作主流 + `buildSystemPrompt` + 工具注册 |
| 接社区/第三方 MCP | **`getMcpServers`（优先）**；勿改系统 yaml |
| 自研工具 | `registerMCPTool` |
| 自己用 fetch 再包一层 | **禁止**（空壳） |

### 3.4 插件里启用 / 合并工作流

```js
const stream = this.getWorkflow('chat');

// 开放：主流 + frameworkToolSurface（remote-mcp 须写入 mergeWorkflows）
await stream.process(e, e.msg);

// 严格：名单即工具面（空数组 = 几乎裸聊）
await stream.process(e, e.msg, {
  mergeWorkflows: ['my-stream', 'memory', 'tools'],
});
```

- **未传** `mergeWorkflows`：开放模式。  
- **传了数组（可空）**：严格模式；未加载的名字忽略并 warn。  
- `remote-mcp.<名>`：与普通 workflow 同等，须显式列入；**不能**当副流 merge 成子对话，只能进工具面。  
- 控制台 / v3：仅请求体 / 勾选的 `workflow.workflows` 生效，无服务端默认名单。

### 3.5 挂载第三方 / 远程 MCP

两条合法路径（底层都进 `remote-mcp.<名>.*`）：

| 路径 | 何时用 | 谁改 |
|------|--------|------|
| **JS：`getMcpServers`（默认）** | 用户要挂 MCP、发来 mcpServers JSON、随工作区交付 | 只写 `workflow/*.js` |
| **yaml：`mcp.remote`** | 用户明确要求改控制台/运行时配置 | 给片段；你**不要**改系统 yaml（写沙箱也进不去） |

都不要 `registerMCPTool` + `fetch` 对方地址当空壳。

#### A. 自研工具

`registerMCPTool` 即可；无需 yaml 登记工具名。默认会话带上：`frameworkToolSurface` / `mergeWorkflows` / 控制台勾选。

#### B. JS 挂载远程 MCP（优先）

加载 workflow 后，若有 **`export function getMcpServers()`**，Loader 把 `{ 服务器名: 配置 }` 记入插件 MCP 并连接。配置与 Cursor 同形：`url`、或 `command`+`args`、可选 `headers` / `transport`（`url` 默认按 http，含路径里的 sse）。

**通用配方**（把用户 JSON 的每个条目原样放进 return）：

```js
// core/workspace-Core/workflow/<短名>-mcp.js
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';

export default class RemoteMcpMount extends AiWorkflow {
  constructor() {
    super({
      name: 'example-mcp',           // 文件名建议一致；流名可不同于服务器名
      description: '挂载远程 MCP：<服务器显示名>',
      version: '1.0.0',
      priority: 5000,
      capabilities: ['tools'],
    });
  }
  async init() {
    await super.init();
  }
}

export function getMcpServers() {
  return {
    // 键 = 服务器名 → 工具前缀 remote-mcp.<键>.*
    'example-server': {
      url: 'https://example.com/sse',
      // command: 'npx', args: ['-y', 'some-mcp'],
      // headers: { Authorization: 'Bearer …' },
    },
  };
}
```

验收：

1. 日志：`检测到 MCP 插件服务器: … (来自 workflow: …)`  
2. 成功时还有 `远程 MCP 工具已注册: …`；失败会打 `获取远程MCP工具失败`（对端协议/网络），**挂载文件仍可算写对**  
3. 控制台勾选 `remote-mcp.<服务器名>` 后才会进工具面（与普通 workflow 相同）

注意：

- **不依赖** `mcp.remote.enabled`（那是 yaml 路径）。  
- 新建 `workflow/` 目录后需重启。  
- stdio 型用 `command`+`args`；HTTP/SSE URL 用 `url`。  
- 仍受 `policies`→`mcp.connect` 与 `security.*` 约束。

#### C. yaml（仅用户明确要求时口述）

`data/server_bots/{port}/ai-workflow.yaml`，须 `mcp.remote.enabled: true`，`mcpServers` 数组里粘贴含 `mcpServers` 的 JSON 块。你写工作区文件**代替不了**这份系统配置。

#### D. 外部 IDE → 本机 XRK（反向）

只读 `../../../docs/mcp-config-guide.md`；不是工作区业务。

### 3.6 自检（workflow / MCP）

- [ ] 第三方：`getMcpServers` 键与用户给的服务器名一致；配置字段未臆造改坏  
- [ ] 未改 `ai-workflow.yaml` / `config/default_config`  
- [ ] 自研工具：`description` + `inputSchema`；`successResponse` / `errorResponse`  
- [ ] 无 `registerMCPTool`+fetch 空壳  
- [ ] 告知验收：路径、重启与否、日志关键词、工具前缀 `remote-mcp.<名>.*`

## 4. ConfigBase

路径：`commonconfig/<名>.js`。yaml **勿**放 `config/default_config/`。

```js
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';

export default class MyConfig extends ConfigBase {
  constructor() {
    super({
      name: 'workspace-demo',
      displayName: '工作区示例',
      filePath: 'data/ai-workspace/default/workspace-demo.yaml',
      defaultTemplatePath: '', // 有模板再填仓库内路径
      schema: { fields: {} },
    });
  }
}
```

---

## 5. ListenerBase / Tasker / www

| | 路径 | 说明 |
|--|------|------|
| events | `events/*.js` | `extends ListenerBase`；订阅读 `{短名}.message|notice|request`；优先用 Plugin `event` |
| tasker | `tasker/*.js` | 默认不写；若写须 `em('{短名}.message')` + `e.tasker` 字符串 |
| www | `www/<应用名>/` | 保留名禁用；兼容见 `xrk-www-compat`（只读） |

```js
import ListenerBase from '#infrastructure/listener/base.js';
export default class MyEvent extends ListenerBase {
  constructor() { super('mycore'); } // 短名与 em / e.tasker 一致
  async init() {
    const bot = this.bot || AgentRuntime;
    bot.on('mycore.message', (e) => this.handle(e));
  }
  async handle(e) {
    if (!this.markProcessed(e)) return;
    this.markTasker(e);
    await this.plugins.deal(e);
  }
}
```

---

## 6. 引入与禁令

| 要用 | 写法 |
|------|------|
| PluginBase / msgSegment / AgentRuntime | 裸名 |
| HttpResponse | `#utils/http-utils.js` |
| normalizeError | `#utils/normalize-error.js` |
| exec | `#utils/exec-async.js` |
| AiWorkflow / ConfigBase / ListenerBase | `#infrastructure/...` 如上 |
| runtimeConfig | `#infrastructure/config/config.js` |

禁止：`node-fetch`、文件内 promisify(exec)、`instanceof Error` 判错、`toString('base64')` 新代码、改 `src/` / 仓库 `core/system-Core`、工作区自建 `package.json`。

---

## 7. 自检（写完过一遍）

- [ ] 路径在 `core/workspace-Core/...`
- [ ] message 用 `rule`；notice/request 无 msg 时用 `accept`
- [ ] 主人命令带 `permission:'master'`
- [ ] 宽正则有 context / 条件，不误吞全站消息
- [ ] HTTP 用 `HttpResponse.*`，对象拍平约定清楚
- [ ] workflow：自研 `registerMCPTool`；远程 **`getMcpServers`（优先）**；勿改系统 yaml；勿 fetch 空壳
- [ ] 远程验收说清：日志关键词 + `remote-mcp.<名>.*`
- [ ] 错误 `normalizeError`；出站 `AbortSignal.timeout`
- [ ] plugin 未 export 非插件符号；workflow 仅额外允许 `getMcpServers`
- [ ] 给用户：路径 + 验收方式（发什么 / 调什么 / 是否要重启）

## 8. 工作方式

1. 常驻 / microagent 够 → write。  
2. 对上 §0 表 → 打开本文件对应节。  
3. 仍不会写 → 按 §9 **只读**深读一层（skill / docs / 示例 / 必要时 `src`），再落盘；禁止改框架。  
4. 用户已要求写 → 勿再确认；「继续」勿空转重读。  
5. 每缺口优先 **一个**深读文件，不够再扩，勿无目的扫仓。

## 9. 可选深读（按需；不会写再开）

优先本文件对应节 → 下表 skill/docs → 仍不清再读仓库示例或 `../../../src/...`（只读）。每缺口先开 **一个**，不够再扩。

| 缺口 | 读 |
|------|-----|
| Node 禁令 | `../../../.cursor/skills/xrk-node-runtime/SKILL.md` |
| HTTP | `../../../.cursor/skills/xrk-http-api/SKILL.md` |
| 工作流 | `../../../.cursor/skills/xrk-ai-workflow/SKILL.md` · `../../../docs/ai-workflow.md` |
| MCP 门禁/远程 | `../../../.cursor/skills/xrk-mcp/SKILL.md` · `../../../docs/mcp-guide.md` · 实现只读 `../../../src/infrastructure/ai-workflow/remote-mcp.js` / `loader.js`（`getMcpServers`） |
| 外部连本机 MCP | `../../../docs/mcp-config-guide.md` |
| www | `../../../.cursor/skills/xrk-www-compat/SKILL.md` |
| 契约摘要 | `../../../docs/base-classes.md` |

简单命令勿扫仓；吃不准字段/挂载时再读上表，**允许**只读 `src`。
