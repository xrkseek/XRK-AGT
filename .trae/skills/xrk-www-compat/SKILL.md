---
name: xrk-www-compat
description: 编写或审查 core/*/www 静态页、校园 WebView 兼容、HttpResponse 前端解包时使用。Core www 走浏览器兼容层（xrk-www-compat）。含零配置静态与有 sign.json（纯静态/产物/反代，sign↔server 合并）挂载。
---

# Core www 浏览器兼容 + 挂载

> **语义权威**：`core/system-Core/www/xrk/src/utils/http.js`  
> **挂载权威**：[docs/www-mount.md](../../../docs/www-mount.md) · `www-app-resolve.js` / `mount-core-www.js`  
> **响应形状**：skill **`xrk-http-api`** · `HttpResponse.success`

## 一层边界

| 环境 | 超时 / ID / 克隆 | HttpResponse |
|------|------------------|--------------|
| Node（`core/*/http`、`src/`） | `AbortSignal.timeout`；**`xrk-node-runtime`** | 只写响应 |
| 浏览器 `www/` | `abortTimeout` / `randomId` / `deepClone` | `unwrapSuccess` 或读顶层 |

## 用法（强制，与 Core 一致）

| 场景 | 做法 |
|------|------|
| `/xrk` 控制台 | `import { … } from '@/utils/http.js'` |
| **其它产品 Core** | **只内联**同语义；**禁止**依赖 `/shared` 或跨应用 `/xrk/...` |
| 经典 `<script>` | 内联，注释写「对齐 xrk/src/utils/http.js」 |

| 导出 | 浏览器勿裸用 |
|------|----------------|
| `randomId` | `crypto.randomUUID()` |
| `unwrapSuccess` | 默认 `json.data.字段` |
| `abortTimeout` | `AbortSignal.timeout` |
| `deepClone` | 无降级 `structuredClone` |
| `copyText` | 裸 `navigator.clipboard`（HTTP 公网页常失败） |
| `downloadBlob` | 手写 `a[download]` 且不统一 revoke |

新能力：**先改** `src/utils/http.js`，再同步各产品内联份。

## www 两类 + 有 sign 时的模式

| | 判定 | 行为 |
|--|------|------|
| 零配置静态 | 无 sign | URL=`/${文件夹名}`，挂目录本体 |
| 有 sign · 纯静态 | `staticRoot: "."` 等 | 挂目录本体；可改 URL / `static` / `rateLimit` |
| 有 sign · 产物 | `enabled: false` | **挂载不启进程**；挂 dist（启动过程仅 stale 时再编） |
| 有 sign · 反代 | `enabled: true` | **启进程 + 反代** |

**`/xrk` dist**：维护者改 `src` 后**建议** `pnpm build` 并把 `dist/` 提交入库；也**支持**用户自行 build / 启动 stale 编（失败仍挂仓内 dist）。见 [docs/www-mount.md](../../../docs/www-mount.md)「`/xrk` 控制台：`dist` 与自建」。

与主服合并：**sign 已写优先，未写回落 `server.yaml`**（`www-sign-merge.js`）。详见 [docs/www-mount.md](../../../docs/www-mount.md)。Vite `base` = `proxy.mount`。

## 审查

- [ ] 无裸 `randomUUID` / `AbortSignal.timeout` / 无降级 `structuredClone`
- [ ] 产品页未 `import` `/shared` 或跨应用 `/xrk/...` 的兼容层
- [ ] 未使用保留目录名 `shared`
- [ ] 有 `sign.json` 的工程：URL 与 `proxy.mount` / Vite `base` 一致
- [ ] `tests/framework/www-web-compat.test.mjs` · `mount-core-www.test.mjs`
