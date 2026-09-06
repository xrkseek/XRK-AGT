# Core www 挂载

> 代码：`www-app-resolve.js` · `www-static-build.js` · `www-sign-merge.js` · `mount-core-www.js` · `frontend/launcher.js`  
> 浏览器兼容：skill **`xrk-www-compat`**

`core/<Core>/www/<子目录>/` 每个一级子目录都会挂载。  
**无 `sign.json`**：零配置静态。  
**有 `sign.json`**：可定制 URL、产物/反代、以及与主服 `server` 的合并覆盖（**sign 已写优先，未写回落主服**）。纯静态页也可以放 `sign.json`。

---

## 总览

```
www/<子目录>/
├── 无 sign.json ────────────────► 零配置静态：URL = /文件夹名，挂目录本体
└── 有 sign.json ────────────────► 可扩展应用（含纯静态）
        ├── serve: static + staticRoot: "." ──► 纯静态：挂目录本体，不 build
        ├── enabled: false / serve: static ───► 启动过程 build，挂载只挂 dist
        └── enabled: true  / serve: proxy ───► 启进程 + 反向代理
```

---

## 零配置静态（无 sign）

| 项 | 规则 |
|----|------|
| 例 | `Some-Core/www/help/`（无 sign）→ `/help/` |
| URL | 永远 `/${文件夹名}` |
| 磁盘 | 目录本体（不探测 dist、不 build） |
| 进程 | 无 |
| 主服选项 | 全用 `server.yaml`（`static` / 全局 `rateLimit` 等） |

保留段：`api`、`core`、`media`、`uploads`、`File`、`shared`。

另：`/core/<Core名>/` 始终指向该 Core 的整个 `www/`（调试用）。

---

## 有 sign.json（含纯静态）

对外 URL（静态与反代共用）优先级：`proxy.mount` → `mount` → `/${id}` → `/${文件夹名}`。  
Vite `base` 必须与该 URL 一致。

例：`system-Core/www/xrk/` → `/xrk/`。

#### `/xrk` 控制台：`dist` 与自建

| 角色 | 约定 |
|------|------|
| **维护者 / 合入方** | 改 `core/system-Core/www/xrk/src/`（或影响产物的配置）后，**建议**本地 `pnpm build`（或仓库根 `pnpm run build:www`），把更新后的 **`dist/` 一并提交入库**，方便编不起来的环境开箱即用 |
| **使用者 / 部署方** | **支持自建**：有 Node + pnpm 时可自行 `cd core/system-Core/www/xrk && pnpm install && pnpm build`；也可靠启动过程 stale 编。编不了或不想编：直接用仓内 `dist`，或设 `XRK_SKIP_WWW_BUILD=1` |
| **运行时** | 挂载只挂已有产物；源码新于 `dist` 时启动过程会尝试再编，**失败仍挂已有 dist** |

### ① 纯静态：`staticRoot: "."`

目录就是成品 HTML/CSS/JS，**不需要** `package.json` / build。仍可用 sign 改 URL、缓存、本路径限流等。

```json
{
  "id": "help",
  "enabled": false,
  "serve": "static",
  "staticRoot": ".",
  "buildOnStart": false,
  "proxy": { "mount": "/help-docs" },
  "static": { "cacheTime": "1h" },
  "rateLimit": { "windowMs": 60000, "max": 300 }
}
```

- 无前端工程树、且根目录有 `index.html` 时，即使未写 `staticRoot: "."`，也会按纯静态挂目录本体。
- 若像 Vite 源码树（有 `package.json` + `vite.config.*` 或 `index.html` 引用 `/src/`）却没有 dist，**不会**挂源码，需先 build 或改 `staticRoot`。

### ② SPA 产物：`enabled: false`（或 `serve: "static"`）

**挂载阶段不 build**；只解析并挂已有产物。构建在 **Bootstrap 启动过程**（或 `pnpm run build:www`）按 stale 执行。

| 步骤 | 行为 |
|------|------|
| 1 | 启动过程：源码比产物新或没有 `dist/index.html` 时执行 `sign.build`（未写则有 `package.json` 时默认 `pnpm build`） |
| 2 | 挂载：主服 `express.static` 挂产物；**Launcher 不拉起** `command` |

```json
{
  "id": "example",
  "enabled": false,
  "serve": "static",
  "staticRoot": "dist",
  "build": { "command": "pnpm", "args": ["build"] },
  "command": "pnpm",
  "args": ["dev"],
  "port": 4173,
  "proxy": { "mount": "/example" }
}
```

- `command` / `port` 在此模式下**不会用到**（留给切到反代时用）。
- **启动过程构建**：`node dist/app.js server`（含 Ctrl+C 热重启子进程）时 Bootstrap 在加载 AGT 之前按 stale 编各有 sign 静态前端（`pnpm run build:www` 等同）；`XRK_SKIP_WWW_BUILD=1` 可跳过。编完子进程退出后再启 AGT，避免同机抢内存。
- `buildOnStart`：仅反代模式（Launcher）使用；静态前端只看 stale。
- `pnpm`/`npm` 经 `#utils/command-spawn.js` 解析（Windows `.cmd`、PATH、`pnpm.cjs`、corepack、`npm exec pnpm`），避免葵子/精简 PATH 下 `spawn pnpm ENOENT`。

### ③ 反代：`enabled: true`

**启动**前端进程，并由主服**反向代理**到 `proxy.mount`。

| 步骤 | 行为 |
|------|------|
| 1 | `mountCoreWwwStatic` **跳过**该目录（不挂静态） |
| 2 | `FrontendLauncher` 执行 `command`/`args`（如 `pnpm dev`），反代到 `port` |

```json
{
  "id": "example",
  "enabled": true,
  "serve": "proxy",
  "command": "pnpm",
  "args": ["dev"],
  "port": 4173,
  "proxy": { "mount": "/example" }
}
```

开发 HMR 用这个；生产流量不要用 `pnpm dev`。  
端口被占用时默认**报错退出**（不静默 `kill -9`）；确需抢端口时加 `"forceFreePort": true`。

### 开关怎么认

| 写法 | 走哪条 |
|------|--------|
| `staticRoot: "."`（或非前端源码树的静态目录） | ① 纯静态 |
| `enabled: false` 或 `serve: "static"`（且有/将有 dist） | ② 启动过程 build、挂载不启动进程 |
| `enabled: true` 且非 static（含 `serve: "proxy"` / 未写 serve） | ③ 启动 + 反代 |

---

## 与主服合并（sign 优先）

主服默认来自 `data/server_bots/{port}/server.yaml`（模板：`config/default_config/server.yaml`）。  
**按挂载点可覆盖**的段写在 `sign.json` 里：字段**已写则以 sign 为准**，**未写则用主服**。实现：`www-sign-merge.js` → `resolveWwwMountOverlays`。

| sign 字段 | 回落主服 | 作用 |
|-----------|----------|------|
| `static`（对象） | `server.static` | 本挂载 `express.static`：`cacheTime` / `index` / `extensions` / `immutable` 等 |
| `cacheTime`（顶层简写） | `server.static.cacheTime` | 等同 `static.cacheTime` |
| `rateLimit`（对象） | `server.rateLimit`（作默认叶子） | **仅本挂载路径**额外限流；未写则只用全局限流 |

`rateLimit` 写法任选其一（均会与主服同名叶子合并，sign 覆盖）：

```json
"rateLimit": { "windowMs": 60000, "max": 500, "message": "本页请求过频" }
```

```json
"rateLimit": {
  "enabled": true,
  "mount": { "windowMs": 60000, "max": 500 }
}
```

- `"rateLimit": { "enabled": false }`：本挂载**不加**路径限流（全局 `server.rateLimit.global` 仍生效）。
- 未写 `rateLimit`：本挂载不加路径限流，完全跟主服全局策略。

不在 sign 里覆盖、始终只看主服的示例：`server.host` / `https` / CORS / 全局 body `limits` 等。

---

## `sign.json` 字段全表（代码已读的全部）

> 权威以本表为准。未列出的键运行时**不读**（`_note` 等仅给人看）。  
> 与主服重叠的项：**sign 已写优先，未写回落 `server.yaml`**（仅下表「主服覆盖」段）。

### 身份与挂载（静态 + 反代）

| 字段 | 类型 | 谁读 | 说明 |
|------|------|------|------|
| `id` | string | resolve / Launcher | 应用 id；缺省为文件夹名。未写 mount 时 URL=`/${id}` |
| `name` | string | Launcher | 展示名（日志）；缺省=`id` |
| `description` | string | Launcher | 元数据描述；缺省空 |
| `proxy.mount` | string | resolve | 对外 URL（最高优先）；Vite `base` 对齐它 |
| `mount` | string | resolve | 对外 URL（次于 `proxy.mount`） |
| `publicPath` | string | Launcher | 反代侧历史别名；未写 mount 时也可作公开路径线索（优先仍是 `proxy.mount`→`mount`→`id`） |

### 运行开关（静态 + 反代）

| 字段 | 类型 | 谁读 | 说明 |
|------|------|------|------|
| `enabled` | boolean | resolve / Launcher | `false` → 不反代（静态路径）；`true` 且非 static → 反代 |
| `serve` | string | resolve | `static`/`dist` 强制静态；`proxy`/`dev` 反代；未写则看 `enabled` |
| `staticRoot` | string | resolve / build | 静态根相对路径；`"."` = 纯静态挂目录本体 |
| `outDir` | string | resolve / build | `staticRoot` 别名 |
| `spa` | boolean | mount | `true` 时对无扩展名的 GET 回落 `index.html`（Vue/React history）。别名 `historyApiFallback` |
| `buildOnStart` | boolean | Launcher | **反代**：有 `build` 段且 `!== false` 时启动前先编。静态前端不读此字段 |
| `build` | object | build / Launcher | `{ command, args?, cwd?, env? }`。静态：无则有 `package.json` 时默认 `pnpm build`。反代：生产路径可先 build 再启进程 |

### 反代进程（仅 `serve=proxy` / `enabled` 未关）

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | string | 启动命令（必需，除非走 `prod.command`） |
| `args` | string[] | 启动参数 |
| `port` | number | 本地前端端口（必需） |
| `cwd` | string | 工作目录（相对**仓库根**解析，见 Launcher） |
| `env` | object | 子进程环境变量；框架会再注入 `PORT`、`VITE_XRK_PUBLIC_PATH`、`VITE_XRK_CORE_NAME`、`VITE_XRK_APP_ID` |
| `autoRestart` | boolean | 退出后是否重启；默认 `true` |
| `forceFreePort` | boolean | `true` 才允许清占用端口；默认 `false`（占线则报错退出） |
| `mode` | `"auto"` \| `"dev"` \| `"prod"` | 缺省 `auto`。`auto` 且存在 `prod` 或 `build` 时按生产入口 |
| `prod` | object | `{ command, args?, cwd?, env? }` 生产启动规格；有则生产用它替代顶层 `command`/`args` |
| `devOnly` | boolean | `true` 且判定为生产时**跳过**该应用 |
| `modes` | string[] | 非空时：当前 mode 不在列表内则跳过（小写比较） |

### 主服覆盖（sign 优先；未写回落 `server.*`）

| 字段 | 类型 | 回落 | 说明 |
|------|------|------|------|
| `static` | object | `server.static` | 本挂载 `express.static`：常用 `cacheTime`、`index`、`extensions`、`immutable` |
| `cacheTime` | string \| number | `server.static.cacheTime` | 顶层简写，等同 `static.cacheTime` |
| `rateLimit` | object | `server.rateLimit` 作默认叶子 | **仅本挂载路径**额外限流。叶子：`enabled`、`windowMs`、`max`、`message`；或 `mount`/`global` 嵌套。未写整段 = 不加路径限流 |

`rateLimit` 示例：

```json
"rateLimit": { "windowMs": 60000, "max": 500 }
```

```json
"rateLimit": { "enabled": false }
```

### 命令对象形状（`build` / `prod` / 顶层 command）

| 子字段 | 类型 | 说明 |
|--------|------|------|
| `command` | string | 可执行名（如 `pnpm`） |
| `args` | string[] | 参数 |
| `cwd` | string | 工作目录（`build` 相对应用目录；Launcher 的 `cwd`/`prod.cwd` 相对仓库根） |
| `env` | object | 额外环境变量 |

### 不在 sign 里、只在主服的

`server.host` / `https` / CORS / 全局 body `limits` / 全局 `rateLimit.global` 与 `rateLimit.api` 等——**不按 Core 拆**；要放宽某页流量用上面的 `sign.rateLimit`。

---

## 启动顺序

```
FrontendLauncher.start()   → 只处理反代工程
mountCoreWwwStatic()       → 零配置静态 + 有 sign 的静态（只挂产物；应用 sign↔server 覆盖）
```

---

## 规范示例

| 目录 | URL |
|------|-----|
| `Example-Core/www/frontend-example/` | `/example` |
| `vibe-learn/www/vibe-learn/` | `/vibe-learn` |
| 纯静态 + `proxy.mount: "/help-docs"` | `/help-docs` |

---

## 要点

- 纯静态可写 sign；`staticRoot: "."` 可定制 URL、缓存与限流。
- `enabled: false`：SPA 在启动过程 build，挂载只挂 dist；无产物且目录像前端源码树时跳过挂载。Vite 进程仅在反代理模式启动。
- URL 映射：无 sign 时文件夹名即 URL；有 sign 时按 `proxy.mount` → `mount` → `id`。
- 静态 build：仅 Bootstrap / `pnpm run build:www`；默认仅源码新于产物时才重新编。
- sign 中的 `rateLimit`：已写叶子以 sign 为准，未写叶子继承主服。
- `buildOnStart`：仅反代控制「有 build 段时是否先编」。

---

## 测试

- `tests/framework/mount-core-www.test.mjs`
- `tests/framework/paths-core-dirs.test.mjs`
