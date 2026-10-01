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
| 模块语言 | 迁移期可用 `.ts`；目标为 `tsc` → `dist/`（见 [ADR-0004](adr/0004-typescript-dist-no-hot-reload.md)） | 生产主路径依赖 strip-types 直跑源码 |
| Map 默认 | `map.getOrInsert(k, () => v)` | `get \|\| set` 样板（可写时） |
| 配置/代码变更 | **重启进程**生效；无业务热重载；**勿加回** `src/utils/hot-reload-base` / chokidar（测：`no-hot-reload` · [ADR-0004](adr/0004-typescript-dist-no-hot-reload.md)） | 引入 chokidar / 自建文件监视 / 恢复 HotReloadBase |
| 类型断言 | 能建最小接口就建；**禁止** `@ts-ignore`；`@ts-expect-error` 仅缺官方类型；少用 `as unknown as`（测：`ts-cast-hygiene`） | 双断言糊弄过编译 / 无注释的 expect-error |
| 挂载 | `setRuntimeGlobal`（`#utils/runtime-globals.js`） | `global.x = globalThis.x =` 双写 |
| 文件名 | 底层模块 **kebab-case**；「一文件一类」用 PascalCase | 底层文件用 camelCase / snake_case |
| 源码编码 | 保持 UTF-8；改完跑 `pnpm test:fast`（含编码门禁 `encoding-integrity`） | 用非 UTF-8 编码批量改写源码（中文会被压成 `?`） |
| 提交前门禁 | `typecheck` · `lint:gate` · `lint:unused` · `test:coverage`（见 §9.5） | 只跑 `test:fast` 就提交 |

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

## 3. 类与状态

```javascript
export default class Demo extends PluginBase {
  // ✅ 类字段：实例状态放字段
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

1. 类字段存 Map / 缓存  
2. `FileLoader.getCoreSubDirFiles(subDir)` 扫描  
3. `importFresh` + `forEachBatch`  
4. **无文件热重载**；改插件/配置/模板后重启。`hot-reload-base` **有意删除**，由 `tests/unit/no-hot-reload.test.mjs`（`pnpm test:fast`）锁定，勿默默加回。见 [ADR-0004](adr/0004-typescript-dist-no-hot-reload.md) · [infrastructure-shared.md](infrastructure-shared.md)

挂载面见 [runtime-surface.md](runtime-surface.md)。

---

## 9. 命名与文件体系

### 9.1 命名

| 类型 | 风格 | 示例 |
|------|------|------|
| 插件 / 工作流 / Tasker 类 | PascalCase | `MyPlugin` |
| 底层模块 / 工具文件 | **kebab-case** | `normalize-error.ts`、`cache-utils.ts` |
| HTTP / 配置文件 | kebab-case | `my-api.js`、`my-config.yaml` |
| 日志 tag | 短横线或中文模块名 | `'MyStream'`、`'配置API'` |

`src/` 现状：kebab-case 172 个为主体，PascalCase 21 个全部是「一个文件一个类」的
client / factory（`AzureOpenAILLMClient.ts`），PascalCase 保留给这类文件；
另有 37 个 camelCase 离群（如 `runDir.ts` 同目录混用）。**新文件一律 kebab-case**，
离群文件随改动时顺手改，勿成批重命名——`src/` 有 Loader 目录扫描与动态 `import()`，
批量改名必须逐个核对调用点，收益不抵风险。

### 9.2 文件头

每个模块首行写一句话说明「它解决什么问题」，非平凡的再加关键约定。
provider / 外部 API 类文件（`src/factory/llm/*`）固定写清五项，模板见
`VolcengineLLMClient.ts`：

```typescript
/**
 * <产品/平台> <接口> 客户端
 * @see <官方文档链接>
 * - baseUrl / path：<默认值与覆盖方式>
 * - 认证：<header 或 query，默认行为>
 * - 多模态 / 工具：<协议差异与限制>
 *
 * harness：`createLlmFromConfig` 对 provider~/<x>/ 走 <adapter 或无>
 */
```

### 9.3 构建产物纪律

`pnpm build` 先跑 `scripts/clean-dist.mjs` 再 tsc。`tsc` 只写新产物、从不删旧文件，
`copy-runtime-assets.mjs` 也只覆盖同名文件——不清理就会留下「源码已删、dist 仍在」的
幽灵模块，集成与 e2e 测试会 import 到它并通过（假绿）。`build:watch` 刻意不接清理脚本。

删源码文件后别手工去 `dist/` 删残留，直接 `pnpm build`。

### 9.4 删死码前的四项核查

「符号零引用」不等于死码。以下四类曾被误判为死码：

| # | 陷阱 | 判据 |
|---|------|------|
| 1 | **namespace import**：`import * as runtimeBoot from '…/runtime-boot.js'` 后的调用写作 `runtimeBoot.runAgentRuntime()`。按「点号前是属性访问、与本符号无关」排除，会把 `runtime-boot` / `middleware` / `observability` / `proxy` 四个启动链路文件（1265 行）全判成死码 | 先收集 `import * as X` 的别名集合，`X.sym` 计入引用 |
| 2 | **扫描根漏 `subserver/`**：`core/` 与 `subserver/pyserver/apis/*/core/plugin/` 里的业务插件用 `#utils/*` alias 直接 import 框架模块。漏扫会把 `buildSubserverFileLink`（被 jmcomic 车牌插件调用）判成死码 | 根目录至少含 `src` `tests` `scripts` `core` `subserver` `agents` |
| 3 | **规则文档即公共 API 承诺**：`PyserverApi`（`.cursor/rules/xrk-third-party-plugins.mdc`）与 `detectArm64`（`.cursor/rules/xrk-infrastructure.mdc` · skill `xrk-infrastructure`）代码内零引用，但规则文档点名承诺 → 保留 | `grep` 名字于 `.cursor/rules/`、`.cursor/skills/`、`docs/`、`subserver/*/README.md` |
| 4 | **同族离群 ≠ 死码**：`act-policy.ts` 12 个策略常量里只有 1 个零引用，说明是「未接线」而非「无人要」；`listSubserverRuntimes` 则是同文件另两处 `Object.entries(CATALOG).map()` 的第三份简写，才是真重复 | 看同族成员：其余都有引用 → 疑似遗漏接线；已有更完整实现 → 重复，删 |

删除后必须 `pnpm build` + `pnpm test:fast` + 真起一次 `node dist/app.js`。死码清理不产生测试失败，**只有启动验证能证明没删错**。

### 9.5 质量门禁

全绿再提交：

| 命令 | 判什么 |
|------|--------|
| `pnpm typecheck` | 全项目类型 |
| `pnpm lint:gate` | ESLint 零问题，且扫描范围没被写空 |
| `pnpm lint:unused` | `src/` 无未使用的 import / 局部 / 参数 |
| `pnpm test:coverage` | fast 用例 + 13 个模块覆盖率门禁 |

- 未用的 import / 局部直接删；签名位置必需的参数加 `_` 前缀，**不要删参数**——express 靠 `fn.length` 判断中间件，`JSON.stringify` 的 replacer 靠位置。`core/` 的 express 签名参数按约定豁免。
- 扫描型判定走权威工具，不自写正则：`lint:unused` 取 tsc 的 `TS6133` / `TS6196` 诊断（正则必在 `import * as X`、re-export 上误判）。
- 每道扫描门禁都要能证明自己在扫：`lint:gate` 判被扫文件数下限，编码门禁扫未提交的新文件，持有坏样本的门禁豁免自己。改门禁后先自证它会失败——`pnpm lint:unused:self-test`、`node tests/checks/lint-gate.mjs --min=999`。
- 编码门禁（`encoding-integrity`）扫 U+FFFD 与「中文被降级成连续问号」。盲区：单字降级成单个 `?` 与 `?alt=sse` 同形，只能靠 git 历史比对。

### 9.6 收敛纪律（去重）

重复实现不是见一个合并一个。**先读调用方、再判语义、后动手**，四类判据：

| 情形 | 处置 |
|------|------|
| 定义逐字相同、调用点只读（`rec()`×11、`errMsg`×3、`asYamlDoc`×2） | 提为公共导出，**别名导入，调用点零改动** |
| 定义相同但返回**冻结对象**（`asPlainDoc` vs `asYamlDoc`） | 不混用——调用方可能把结果放进可写容器（`this.config[key]`），换成冻结对象会在 strict mode 抛错 |
| 语义差异合理（`isLoopbackHost` 安全侧 vs 配置侧、`validateCommand` 粗名单 vs 精确表、时间过滤的错误码契约） | **不合并**，保留差异；用一致性测试锁定同步 |
| 跨层镜像（LLM 工厂清单 src↔core，字段交集仅 name/displayName） | 不合并（core 的 preset 驱动 schema 生成，无法从 src 派生）；用 `llm-factory-alignment` 测试锁同步 |

- **目录递归**统一走 `walkFiles(dir, { skipDirs, maxDepth, maxFiles, match })`（`src/utils/walk-files.ts`）。差异用显式选项表达，别再各写一份。
- **getInfo 类自述信息**统一走 `defaultApiInfo`（`src/infrastructure/http/utils/helpers.ts`）。Loader 的兜底实现与 `HttpApi.getInfo()` 共用，避免字段清单各自维护漏字段。
- **渲染器健康检查**：`startHealthCheck()` 在基类，子类只实现 `healthProbe()` 钩子。
- **LLM 工厂注册表**：`factoryRegistry` 是运行时真源（`src/factory/llm/LLMFactory.ts`），已导出供测试对齐；侧栏元数据在 core 侧，改一边必须过 `llm-factory-alignment`。

---

## 审查（改 Core 前 30 秒）

- [ ] 无 `global.` 前缀（业务裸名或 import）  
- [ ] 无 constructor 可变容器  
- [ ] 无 `node-fetch` / 分散 `promisify(exec)` / `instanceof Error`  
- [ ] 无 `@ts-ignore`；少用 `as unknown as`（见 `ts-cast-hygiene`）  
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

*最后更新：2026-09-30*
