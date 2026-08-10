# 插件加载器文档

| 项 | 说明 |
|----|------|
| **源码** | `src/infrastructure/plugins/loader.js` |
| **配对基类** | [plugin-base.md](plugin-base.md)（规则、上下文、工作流） |
| **事件链路图** | 见 [plugin-base.md § 事件链路](plugin-base.md#事件链路) |
| **扩展总览** | [框架可扩展性指南](框架可扩展性指南.md) |
| **Loader 模式** | [infrastructure-shared.md](infrastructure-shared.md) |

`PluginLoader` 是 XRK-AGT 的 **插件调度核心**，负责：

- 扫描并加载所有 `core/*/plugin`、办事工作区 `data/ai-workspace/*/core/*/plugin`、以及子服 `apis/*/core/plugin`
- 配置全在主服 CommonConfig；子服只读 `data/`，见 [subserver-commonconfig.md](subserver-commonconfig.md)
- 管理插件规则匹配、权限检查、上下文处理、冷却与节流
- 处理多种事件源（普通消息、设备事件、STDIN/API 事件）
- 维护定时任务、事件订阅与全局事件历史

> **注意**：框架支持多 core 模块架构。`PluginLoader` 经 `discoverAllCoreSubDirs`（`src/utils/core-fs.js`）合并三类目录：仓库 `core/*/plugin`、子服 `subserver/*/apis/*/core/plugin`、办事工作区 `data/ai-workspace/{id}/core/*/plugin`。工作区种子见 `agents/workspace/core/`；写法技能 **agent-core-dev**。

事件链路导读见 [plugin-base.md § 事件链路](plugin-base.md#事件链路)；Loader 扫描与热重载见 [infrastructure-shared.md](infrastructure-shared.md)。

## 📚 目录

- [扩展特性](#扩展特性)
- [架构与业务层位置](#架构与业务层位置)
- [核心职责概览](#核心职责概览)
- [加载流程](#加载流程)
- [事件处理主流程](#事件处理主流程)
- [冷却、节流与黑白名单](#冷却节流与黑白名单)
- [事件系统与订阅（聚焦 Loader 角色）](#事件系统与订阅聚焦-loader-角色)
- [定时任务系统](#定时任务系统)
- [与工作流系统集成](#与工作流系统集成)
- [热加载系统](#热加载系统)
- [开发与调试建议](#开发与调试建议)

---

## 架构与业务层位置

PluginLoader 位于「事件系统 → 业务插件 → AI 工作流」链路的中间，负责把标准化事件分发给各业务插件：

- **事件入口**：来自 Tasker / 事件监听器的标准化事件，通过 `PluginLoader.deal(e)` 进入插件系统
- **业务插件编排**：
  - `super({ priority: 'extended' })` → `extended[]`；否则 → `priority[]`（源码：`loader.js` `loadPlugin`）
  - `deal(e)` 先跑 `extended`，再按插件 `priority` **升序**分组跑普通插件
  - 统一执行 `accept` → 规则匹配 → 默认 handler
- **与基类协作关系**：
  - 面向插件基类 `plugin`：只依赖基类约定的字段和方法（`rule/task/eventSubscribe/accept` 等）
  - 面向事件系统：依赖 `EventNormalizer` 输出的标准事件对象，不关心具体协议细节

> 关于单个插件本身的结构与能力，请结合 `docs/plugin-base.md` 一起阅读，本篇只聚焦「业务层调度器」的角色。

---

## 核心职责概览

- **插件生命周期**
  - 扫描插件目录并动态 `import` 插件模块。
  - 实例化插件、执行 `init()` 钩子。
  - 构建 `priority/extended/task/defaultMsgHandlers` 等内部结构。
  - 支持热更新、文件新增/删除监听

- **事件分发与规则匹配**
  - 使用 `EventNormalizer` 统一标准化事件对象（`normalizeEventPayload`）
  - 对 `AgentRuntime.em` 派发的事件进行预处理（消息解析、权限、黑白名单）
  - 插件匹配和执行流程优化，减少冗余判断
  - 支持「扩展插件 extended」与「普通插件」分组执行

- **定时任务与统计**
  - 基于 `node-schedule` 创建 Cron 定时任务。
  - 统计截图与发送消息次数，并写入 Redis 计数键。

- **事件系统扩展**
  - 提供自定义事件 `emit(eventType, eventData)` 能力，统一走 `AgentRuntime.em`。
  - 维护事件历史 `eventHistory`，支持按条件查询。
  - 允许插件订阅任意事件（包括自定义事件）。

---

## 加载流程

**插件加载完整流程**:

```mermaid
flowchart TB
    A["PluginLoader.load"] --> B{"是否已加载"}
    B -->|是且非刷新| Z["直接返回"]
    B -->|否或刷新| C["重置内部状态"]
    C --> D["扫描目录"]
    D --> E["分批并发导入"]
    E --> F["动态导入"]
    F --> G["创建实例"]
    G --> H{"priority类型"}
    H -->|extended| I["归类到extended"]
    H -->|普通| J["归类到priority"]
    I --> K["处理handler"]
    J --> K
    K --> L["创建定时任务"]
    L --> M["初始化事件系统"]
    M --> N["按优先级排序"]
    N --> O["加载完成"]
    
    style A fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style G fill:#FFF3E0,stroke:#F57C00,stroke-width:2px
    style O fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
```

### 1. `load(isRefresh = false)`

- 若不是刷新且已经加载过插件，则直接返回
- 记录加载开始时间，重置内部状态（priority/extended/task）
- 调用 `getPlugins()` 扫描所有 `core/*/plugin` 目录
- 分批（batchSize = 10）并发导入插件
- 调用后续处理函数完成初始化

> 插件开发者只需要在任意 core 目录的 `plugin` 子目录下新建 JS 文件（如 `core/my-core/plugin/my-plugin.js`），即可被自动发现和加载

### 2. `importPlugin(file, packageErr, skipInit)`

- `importPluginModule(file, packageErr)` 动态导入模块
- 支持导出对象 `apps`（多插件聚合）或单一导出
- 对每个导出的插件类调用 `loadPlugin(file, PluginClass, skipInit)`
- `skipInit` 参数用于热加载时跳过重复初始化

### 3. `loadPlugin(file, PluginClass, skipInit)`

**核心优化**：
- 提取了 `initializePlugin`、`registerPluginTasks`、`buildPluginMetadata`、`registerPluginHandlers` 等独立方法
- 支持 `skipInit` 参数，热加载时可跳过重复初始化
- 初始化超时从 5 秒优化为 3 秒

```mermaid
flowchart TB
    A["loadPlugin"] --> B{"是否有prototype"}
    B -->|否| Z["忽略非类导出"]
    B -->|是| C["创建插件实例"]
    C --> D["执行plugin.init"]
    D --> E["标准化task"]
    E --> F["编译rule正则"]
    F --> G["构建插件描述"]
    G --> H{"priority判断"}
    H -->|extended| I["归类到extended"]
    H -->|普通| J["归类到priority"]
    I --> K["处理handler"]
    J --> K
    K --> L["处理eventSubscribe"]
    
    style A fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style C fill:#FFF3E0,stroke:#F57C00,stroke-width:2px
    style K fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
```

---

## 事件处理主流程

### 1. 入口：`deal(e)`

**事件处理完整流程**:

```mermaid
flowchart TB
    A["deal入口"] --> B["补全属性"]
    B --> C{"特殊事件?"}
    C -->|是| D["特殊处理"]
    C -->|否| E["检查bypass"]
    E --> F["前置检查"]
    F --> G{"检查结果"}
    G -->|失败| Z["跳过处理"]
    G -->|通过| H["解析消息"]
    H --> I["包装回复"]
    I --> J["运行时初始化"]
    J --> K["执行扩展插件"]
    K --> L["执行普通插件"]
    L --> M["处理完成"]
    
    style A fill:#E3F2FD,stroke:#1976D2,stroke-width:2px
    style F fill:#FFF3E0,stroke:#F57C00,stroke-width:2px
    style M fill:#E8F5E9,stroke:#388E3C,stroke-width:2px
    style Z fill:#FCE4EC,stroke:#C2185B,stroke-width:2px
```

**步骤说明**：

1. `initEvent(e)` - 补全 `self_id/bot/event_id`，统计接收计数
2. 若为特殊事件（STDIN/API 或设备），交给 `dealSpecialEvent(e)`
3. `checkBypassPlugins(e)` - 检查是否有带 `bypassThrottle` 且规则匹配的插件
4. `preCheck(e, hasBypassPlugin)` - 前置检查：
   - 忽略自身消息
   - 检查关机状态
   - 检查频道消息、黑名单
   - 检查消息冷却与节流
5. `dealMsg(e)` - 解析消息内容、构建日志文本、注入工具方法
6. `setupReply(e)` - 包装 `e.reply`，统一处理引用、@、撤回等逻辑
7. `Runtime.init(e)` - 插件运行时初始化
8. `runPlugins(e, true)` - 先执行扩展插件
9. `runPlugins(e, false)` - 再执行普通插件规则

### 2. `dealMsg(e)`

- `initMsgProps(e)`：初始化通用消息属性（`e.img/e.video/e.audio/e.msg`，以及可选的 `e.fileList` / `e.forwardIds`）。Tasker特定的属性（如`atList`、`atBot`）由Tasker增强插件处理。
- `parseMessage(e)`：遍历 `e.message`，处理通用消息类型（`text/image/mface/video/audio|record/file/forward`）。`mface` 计入 `e.img`；`forward` 的 id 记入 `e.forwardIds`。Tasker特定类型（如`at`、`reply`、`face`）由Tasker增强插件处理。
- `getSendableMedia`：经 `#utils/entry-media.js` 的 `readMediaBuffer` 拉取 Buffer（`image→get_image`，`file/video/record→get_file` 等）。
- `setupEventProps(e)`：
  - 标记通用事件类型（`isDevice/isStdin`）。
  - 设置基础 `sender` 信息。
  - Tasker特定的属性（`isPrivate/isGroup/isGuild`、`group_name`、`friend/group/member`等）由Tasker增强插件处理。
- `checkPermissions(e)`：识别主人（master）与 STDIN 默认主人权限。
- `processAlias(e)`：群聊场景下处理 AgentRuntime 别名（如「葵子」）。
- `addUtilMethods(e)`：注入 `getSendableMedia/throttle/getEventHistory` 等工具。

### 3. `runPlugins(e, isExtended)`

- `initPlugins(e, isExtended)`：
  - 遍历 `this.priority` 或 `this.extended`。
  - 实例化插件并设置 `plugin.e = e`。
  - 编译规则 `rule.reg`。
  - 按 `checkDisable` 与 `filtEvent` 过滤禁用或事件不匹配的插件。
- 若为扩展插件：
  - 直接调用 `processRules(plugins, e)`。
- 若为普通插件：
  - 先执行各插件的 `accept(e)`（包括Tasker增强插件与响应控制逻辑）：
    - Tasker增强插件（如`OneBotEnhancer`、`StdinEnhancer`、`DeviceEnhancer`）会在此阶段挂载Tasker特定属性或标准化日志。
    - `OneBotEnhancer` 内置别名与 `onlyReplyAt` 策略，用于决定是否继续向下游插件传递事件。
    - 若返回 `'return'`，则视为已完全处理。
    - 若返回 `false`，跳过当前插件。
    - 若返回 `true`，继续处理。
  - 对非设备/STDIN 事件：
    - `handleContext(plugins, e)`：先处理上下文回调。
    - 若插件不带 `bypassThrottle`，调用 `setLimit(e)` 设置冷却。
  - 最后执行 `processRules(plugins, e, false)` 并根据优先级分组执行。
  - 若仍未处理，调用 `processDefaultHandlers(e)`。

---

## 冷却、节流与黑白名单

- **冷却（CD）**
  - 使用 Map 维护：
    - `this.cooldowns.group`：群级别冷却。
    - `this.cooldowns.single`：群内单人冷却。
    - `this.cooldowns.device`：设备事件冷却。
  - `checkLimit(e)`：在前置检查中判断是否处于冷却期。
  - `setLimit(e)`：在确定要处理消息时写入冷却 Map。

- **节流**
  - `this.msgThrottle`：基于 `user_id:message_id` 的消息去重。
  - `this.eventThrottle`：按 (`user/device` + key) 的事件节流。

- **黑白名单 / 响应策略**
  - `checkBlack(e)`：从配置 `other` 中读取：
    - `blackQQ/whiteQQ/blackGroup/whiteGroup/blackDevice` 等。
  - `OneBotEnhancer`：根据群配置 `onlyReplyAt` 与 `botAlias` 判断是否仅在有 @ 或前缀时响应，并在 `accept` 阶段直接拦截不需要继续处理的事件。

---

## 事件系统与订阅（聚焦 Loader 角色）

PluginLoader 与标准化事件系统紧密集成，但**不再在本篇重复事件命名与字段责任的全部细节**，这些内容已集中在 `docs/事件系统标准化文档.md` 中。

在整体事件链路中，PluginLoader 的职责主要包括：

- **消费标准化事件对象**：
  - 依赖 Tasker / 事件监听器 提供的基础字段（`tasker/post_type/message_type/...`）
  - 使用 `EventNormalizer.normalize`（内含 `normalizeEventTaskerFields`）；匹配见 `event-keys.js`
  - 补全插件业务层需要的通用字段与工具方法（`bot/sender/reply/getSendableMedia/throttle/getEventHistory` 等）
- **负责插件侧过滤与分发**：
  - 通过 `filtEvent` → `#utils/event-keys.js` `matchPluginEvent`：定 Tasker 订阅互不串台；跨 Tasker 用 `message` / `notice.*`
  - 维护 `eventHistory`、节流与冷却 Map，并在 `initEventSystem()` 中定期清理
  - 在 `AgentRuntime` 上注册通用事件监听（`message/notice/request/device`），统一分发给订阅者和业务插件

> 事件命名规则、匹配优先级以及 Tasker / 监听器 / Loader 之间的字段责任边界，请统一参考：  
> `docs/事件系统标准化文档.md`（避免与本篇产生冗余说明）。

- **事件历史：`recordEventHistory(eventType, eventData)`**
  - 将事件以 `{ event_id, event_type, event_data, timestamp, source }` 形式追加到 `eventHistory`。

- **订阅与分发**
  - `subscribeEvent(eventType, callback)`：
    - 注册自定义事件回调。
    - 返回一个取消订阅函数。
  - `distributeToSubscribers(eventType, eventData)`：
    - 遍历订阅列表并安全执行回调。

- **自定义事件：`emit(eventType, eventData)`**
  - 构造 `post_type: 'custom'` 的事件对象。
  - 通过 `AgentRuntime.em(eventType, event)` 派发。
  - 同时记录历史并调用订阅者。

---

## 定时任务系统

- 插件可在 `plugin.task` 中定义任务，例如：
  - `{ name: 'heartbeat', cron: '0 */5 * * * *', fnc: 'heartbeat' }`。
- `createTask()`：
  - 使用 `schedule.scheduleJob` 创建 Cron 任务。
  - 支持重复检测与日志标记。
  - 执行函数 `task.fnc()` 时自动统计执行耗时并输出日志。

---

## 与工作流系统集成

PluginLoader 与工作流系统无缝集成，插件可以通过 `getWorkflow()` 访问工作流：

```javascript
// 插件中调用工作流
async handleMessage(e) {
  const stream = this.getWorkflow('chat');
  if (stream) {
    await stream.process(e, e.msg, {
      enableMemory: true,
      enableDatabase: true
    });
  }
}
```

**集成流程**：
1. 插件通过 `this.getWorkflow(name)` 获取工作流实例
2. 调用 `stream.process(e, question, options)` 执行工作流
3. 工作流内部自动处理回复发送，插件不需要再次调用 `reply()`

---

## 热加载系统

PluginLoader 支持完整的插件热加载功能，包括新增、修改和删除插件的自动处理。

### 启用热加载

```javascript
// 在 AgentRuntime.run() 中自动启用
await PluginLoader.watch(true);
```

### 热加载流程

**新增插件** (`onAdd`)：
1. 检测到新文件时，自动加载插件
2. 创建定时任务
3. 重新排序和识别默认消息处理器
4. 输出加载日志

**修改插件** (`onChange`)：
1. `HotReloadBase` 校验内容 hash，未变则 **不进入** `changePlugin`
2. `changePlugin(key, filePath)` 用监视器报告的绝对路径卸载并重载
3. `_rebuildPluginGraph()` → `createTask()` 仅在 cron 指纹变化时重建定时任务
4. 重新排序和识别默认消息处理器

**删除插件** (`onUnlink`)：
1. 经 600ms 延迟确认（避免原子保存误删）；期间文件恢复则跳过
2. 清理定时任务、Handler、事件订阅等
3. 重新识别默认消息处理器

### 热加载优化

- **内容去重**：底层 `HotReloadBase` 对 add/change 做 SHA256 比对，编辑器 touch-only 或 chokidar 重复事件不会触发业务重载
- **unlink 防抖**：rename 式保存不会误走卸载再加载
- **Cron 指纹**：`_taskScheduleKey` 避免插件热更但 schedule 未变时刷屏「加载定时任务」
- **资源清理**：卸载时完整清理所有相关资源，避免内存泄漏
- **精确路径**：`changePlugin` 优先 `filePath`，不单靠 basename 查找
- **错误隔离**：单个插件热加载失败不影响其他插件

---

## 开发与调试建议

### 编写插件时

- **解耦设计**：尽量让插件逻辑与 `PluginLoader` 解耦，只依赖 `plugin` 基类与事件对象 `e`
- **命名规范**：使用明确的 `name` 与 `priority`，避免与系统插件产生抢占冲突
- **工作流集成**：通过 `getWorkflow()` 访问工作流，使用 `process()` 方法执行
- **错误处理**：始终使用 try-catch 包裹工作流调用，提供友好错误提示

### 排查问题时

1. **插件加载检查**：
   - 查看插件是否被 `checkDisable` 或黑白名单过滤
   - 检查插件文件是否正确放置在 `core/*/plugin/` 目录
   - 查看加载日志，确认插件是否成功加载

2. **事件处理检查**：
   - 检查是否被 `OneBotEnhancer` 的别名/onlyReplyAt 策略拦截
   - 检查是否被冷却限制挡掉
   - 检查事件类型是否匹配（`event` 属性）

3. **工作流调用检查**：
   - 确认工作流是否已加载（`AiWorkflowLoader.getWorkflow(name)`）
   - 检查工作流配置是否正确（`embedding`、`config` 等）
   - 查看工作流执行日志

4. **系统状态检查**：
   - 通过 Redis（键前缀 `AGT:count:`、`AGT:shutdown:` 热关机标记）确认运行状态
   - 查看 AgentRuntime 运行日志
   - 检查 HTTP API 是否正常

### 性能优化

- **规则设计**：对于高频事件，注意规则设计与日志级别，避免过多无效正则测试与日志输出
- **节流使用**：合理使用 `bypassThrottle`，只为少数必要命令开启
- **工作流优化**：合理使用 `enableMemory`、`enableDatabase` 等选项，避免过度检索
- **上下文管理**：及时清理上下文，避免长期占用内存

---

## 相关文档

- **[插件基类文档](plugin-base.md)** - 插件开发详细说明
- **[事件系统标准化文档](事件系统标准化文档.md)** - 事件命名与字段责任说明
- **[框架可扩展性指南](框架可扩展性指南.md)** - 扩展开发完整指南

---

*最后更新：2026-06-14*
