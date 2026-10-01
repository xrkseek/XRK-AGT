# TypeScript 编译至 dist + 移除热重载

> **分支**：`refactor/typescript`  
> **状态**：Accepted  

> **日期**：2026-09-05  
> **关联 ADR**：[0004](../../adr/0004-typescript-dist-no-hot-reload.md)

## 1. 背景

XRK-AGT 以 Node.js ESM + 大量 `.js` 运行；已有渐进 TS 约定（`--experimental-strip-types`、`tsc --noEmit`），但几乎未迁（仅 `src/utils/module-ext.ts`）。

目标改为：**源码 TypeScript → `tsc` 产出 `dist/`，进程只跑编译结果**；并 **删除全部热重载**（模块 / YAML / 模板），避免「源码直载」与 emit 模型冲突。

## 2. 已确认决策

| 项 | 选择 |
|----|------|
| 运行模型 | **`tsc` emit → `dist/`**（不再依赖 strip-types 跑源码） |
| 热重载 | **全砍**：plugin/http/workflow/commonconfig 模块、YAML config、Renderer 模板 watch |
| 范围 | **`app` + `src/` + `core/`** 统一进编译；`subserver/`、独立 www 前端构建不在本设计内改语义 |
| 业务 | 不改 HTTP/YAML schema/harness 契约；类型暴露的 bug 可顺手修 |

## 3. 目标架构

```text
仓库源码（.ts）
  app.ts
  src/**/*.ts
  core/**/*.ts          ← Loader 扫描的是编译后的路径
        │
        ▼  pnpm build  (tsc -p tsconfig.build.json)
  dist/
  app.js
  src/...
  core/...
        │
        ▼  node dist/app.js   （或 package.json main → dist/app.js）
```

- **开发**：改源码 → `pnpm build`（或 `tsc -w`）→ 重启进程。无 chokidar 业务热重载。
- **类型检查**：`pnpm typecheck` 可继续 `tsc --noEmit`（editor / CI）；与 build 共用严格选项，build 另开 `noEmit: false` + `outDir`。
- **`#` 别名**：运行时 `package.json` `imports` 指向 `./dist/src/...`（及必要时 `./dist/core/...`）；源码内 import 扩展名保持 ESM 可解析约定（写 `.js` 对应产出，与 NodeNext 一致）。

## 4. 热重载移除范围

删除或掏空以下能力（启动只做一次扫描/加载）：

| 区域 | 现状 | 目标 |
|------|------|------|
| `#utils/hot-reload-base.js` | chokidar 封装 | **删除**；调用方改为无 watch |
| plugin / http / ai-workflow / commonconfig Loader | `_hotReload` | 去掉 start/stop watch |
| `loader-hot-reload.js` 等 mixin | 热更插件 | **删除**或改为空操作后移除 |
| `config.js` YAML watch | 改 yaml 热生效 | **删除**；改配置需重启 |
| `Renderer` 模板 watch | 清缓存 | **删除**；改模板需重启 |
| `loader-shutdown.js` | stop watchers | 简化为仅停必要资源（无 chokidar） |
| 依赖 `chokidar` | package.json | 若无其它引用则 **移除依赖** |

文档同步：`coding-style.md`、`node-26-runtime.md`、`api-loader.md`、`plugins-loader.md`、`renderer.md` 中热重载/strip-types 直跑源码的表述。

## 5. 构建与入口

### 5.1 tsconfig

- 保留根 `tsconfig.json`：`strict`、`NodeNext`、`paths` 与 `#` 对齐；**typecheck / IDE** 用。
- 新增 `tsconfig.build.json`：`extends` 根配置；`noEmit: false`；`outDir: dist`；`rootDir` 覆盖 `app.ts` + `src` + `core`（或等价 `include`）；`allowJs: true` **仅迁移期**，迁完后收紧为仅 `.ts`。
- **不**把 `tests/`、`www`、`node_modules`、现有前端 `dist` 打进运行时 `dist/`。

### 5.2 脚本与启动

| 脚本 | 行为 |
|------|------|
| `pnpm build` | `tsc -p tsconfig.build.json` |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit` |
| `pnpm start` / `dev` | **先 build（或要求已 build）** → `node dist/app.js`；去掉 `--experimental-strip-types` 作为主路径 |
| `start.bat` / `start.sh` | 同上 |

Docker / CI：镜像构建步骤增加 `pnpm build`；运行目录以 `dist` + 仍需的 `config/`、`data/`、静态资源为准。

### 5.3 Loader 路径

- 扫描根改为 **`dist/core/<name>/...`**（或 `path.join(paths.root, 'dist/core')`），与 `warmupCoreLayout` / `core-fs` 约定一并改。
- 模块扩展名：编译后以 `.js` 为主；迁移期若仍有未迁 `.js` 源，build 用 `allowJs` 拷贝进 `dist`。
- **禁止**运行时再 `import` 仓库根下未编译的 `src/`、`core/` 业务模块（测试与脚本除外，另约定）。

## 6. 迁移顺序（同一分支多 commit）

1. **砍热重载**：删 `HotReloadBase` 链路与 chokidar；更新 shutdown；文档；保持仍为 JS 可跑。
2. **搭 build**：`tsconfig.build.json`、`pnpm build`、入口与 `#` → `dist`；最小 `app`/`bootstrap` 能从 dist 启动（允许大量仍为 JS + allowJs）。
3. **迁 `src/utils` 叶子** → `infrastructure` / `factory` / `renderers` → `agent-runtime` / 根 `app`。
4. **迁 Core**：`harness-proxy-Core` → JM/QQ/Roco → `system-Core`。
5. **收尾**：去掉迁移期 `allowJs`（或仅留边界例外）；CI 强制 `build` + `typecheck` + 既有 test；修订 ADR/本设计状态为 Accepted。

每步保持：`pnpm build` 成功 + 烟雾级启动/`pnpm test:fast`（或项目等价）可通过。

## 7. 非目标

- 不重写 harness / LLM 业务逻辑。
- 不合并或拆分 Core 产品边界。
- 不把 `subserver/*` 纳入本次 TS emit。
- 不引入新的运行时热重载替代品（含配置热更）。
- 不做「整仓一次 PR 大爆炸」合并策略以外的并行大分支；工作集中在 `refactor/typescript`，可按上述顺序拆 commit / 可选拆 PR。

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `#` imports 与 dist 路径不一致 | build 后单测/启动冒烟；统一改 `package.json` imports |
| 动态 `import()` 拼路径仍指向源码树 | 集中改 `core-fs` / FileLoader / paths；全局搜 `core/` 绝对加载 |
| `allowJs` 掩盖未迁文件 | 阶段 5 关闭或 CI 统计残留 `.js` |
| Docker 体积/层 | 多阶段：build 阶段 tsc，runtime 只拷 `dist` + 资源 |
| 去掉 YAML 热更影响运维习惯 | README/startup 写明「改配置需重启」 |

## 9. 成功标准

| `--experimental-strip-types` 主路径 | 已改为 `pnpm build` → `node dist/app.js` |
| `dist/` 由 `pnpm build` 生成 | 是（根 `dist/` gitignore） |
| 无业务热重载 / 无 HotReloadBase / 无 chokidar | 是 |
| `src/` + `core/` 以 `.ts` 为源 | 迁移中（allowJs 期仍大量 `.js`） |
| `pnpm typecheck` 与测试门禁 | CI 已 `pnpm build` + `test:fast` |
| 文档与 ADR-0004 | Accepted |

## 10. 开放细节（实施计划阶段定稿）

- `rootDir` / 是否把 `app.ts` 放根 vs `src/cli`：实施时选对 `outDir` 最简的一种。
- 开发是否提供 `tsc -w` + 手动重启的 npm script 组合。
- 测试是跑源码（tsx）还是跑 `dist`：优先与生产一致跑 `dist`，若成本过高可对 unit 用 strip/tsx 并在计划中写明。
