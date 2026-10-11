---
name: xrk-node-runtime
description: 编写或审查 core/src 代码时，确保使用 Node 26 稳定 API，禁止旧写法（fetch/exec/错误/二进制）。AI 改 Core 前必读。
---

## 文档

- 权威清单：`docs/node-26-runtime.md`
- 写法与性能（非 Node 专项）：`docs/coding-style.md` · skill **`xrk-coding-style`**
- 工具模块：`docs/底层架构设计.md` §1 工具表

## 版本

- **要求**：Node ≥ 26.0（推荐 / 实测 **26.7.x**，至少 ≥ 26.5.1）；`package.json` engines 与 `app.ts` / `dist/app.js` 启动校验一致。
- **勿用**：Node 24 特性检测回退、polyfill、未在文档列出的实验 API（如 `node:ffi`，除非用户明确要求）。

---

## Core / 业务代码（`core/**/*.{js,ts}`）必用

| 场景 | 正确写法 | 禁止 |
|------|----------|------|
| HTTP 出站 | 全局 `fetch(url, { signal: AbortSignal.timeout(ms), ...opts })` | `node-fetch`、`import fetch from ...` |
| LLM 代理 | `buildFetchOptionsWithProxy(config, opts)`（`#utils/llm/proxy-utils.js`） | `https-proxy-agent`、`options.agent` |
| Shell 命令 | `import { exec } from '#utils/exec-async.js'`（有 `#` 的 core）或相对路径到 `src/utils/exec-async.js` | `util.promisify(exec)`、`child_process/promises` |
| 流式 Shell | 需 `stdout`/`stderr` 实时流时可用 `child_process.exec` 回调 API（如 `remote-command.js`） | 在普通 await 场景自写 promisify |
| 判错 | `Error.isError(err)`；需包装时用 `normalizeError(err)`（`#utils/normalize-error.js`） | `err instanceof Error` |
| Buffer 编码 | `buf.toBase64()`、`buf.toHex()`、`Uint8Array.fromBase64(s)` | `buf.toString('base64'|'hex')`、`Buffer.from(s,'base64')` |
| Map 初始化 | `map.getOrInsert(k, () => ({ ... }))` / `getOrInsertComputed` | `map.get(k) \|\| (map.set(k,v), v)` 样板（可写时） |
| 下载文件 | `fetch` + `Readable.fromWeb` + `pipeline`（见 `subserver-client.fetchSubserverToPath`） | 自写 `node-fetch` pipeline |
| 路径匹配 | `new URLPattern({ pathname })` | 手写 regex fallback、`globalThis.URLPattern ?` |
| URL-safe Base64 | `buf.toBase64({ alphabet: 'base64url' })`、`Uint8Array.fromBase64(s, { alphabet: 'base64url' })` | 手写 base64url 替换 |
| 文件 glob | `import { glob } from 'glob'`（`RuntimeUtil.glob` 已封装） | 动态加载 fast-glob、自写 `#getGlobLib` |

## 基础设施（`src/**/*.js`）

- 同上；**唯一**允许 `util.promisify(exec)` 的位置：`src/utils/exec-async.js`。
- 错误：`errorHandler` + `normalizeError`；日志：`Error.isError` 分支（见 `log.js`）。

## 代码示例（Core HTTP handler）

```javascript
import { HttpResponse } from '#utils/http-utils.js';
import { normalizeError } from '#utils/normalize-error.js';

export default {
  routes: [{
    method: 'GET',
    path: '/api/example/ping',
    handler: HttpResponse.asyncHandler(async (req, res) => {
      const resp = await fetch('https://example.com', {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return HttpResponse.success(res, await resp.text());
    }, 'example')
  }]
};
```

## 代码示例（Core 工作流 / 插件 catch）

```javascript
} catch (err) {
  const error = normalizeError(err);
  RuntimeUtil.makeLog('error', error.message, 'MyStream');
}
```

## 代码示例（Shell / 热重载）

```javascript
import { exec } from '#utils/exec-async.js';

const { stdout, stderr } = await exec('node --version');
// 至 26.7 仍无 node:child_process/promises — 勿在各文件 promisify(exec)
```

## 代码示例（二进制 / 设备路径）

```javascript
const fileId = Buffer.from(filePath, 'utf8').toBase64({ alphabet: 'base64url' });
const path = Buffer.from(Uint8Array.fromBase64(fileId, { alphabet: 'base64url' })).toString('utf8');
```

## 审查清单（改 Core 前自检）

- [ ] 无 `node-fetch`、`https-proxy-agent`
- [ ] 无 `import ... child_process/promises`
- [ ] 无文件内 `promisify(exec)`（应用 `exec-async.js`）
- [ ] 无 `AbortController` + `setTimeout(abort)`
- [ ] 无 `instanceof Error` 作判错（展示类型名除外）
- [ ] 无 `URLPattern` / `Error.isError` 存在性检测
- [ ] 无 `toString('base64'|'hex')` / `Buffer.from(s,'base64')` 新代码
- [ ] Core 改底层需求：提 issue/说明，**不直接改** `src/infrastructure/`、`src/utils/`（见 `xrk-core-code.mdc`）
