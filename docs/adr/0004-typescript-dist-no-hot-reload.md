# ADR-0004: TypeScript 编译至 dist，并移除热重载

- **Status:** Accepted
- **Date:** 2026-09-05
- **Reviewed:** 2026-09-12（与代码一致）
- **Tags:** typescript, build, hot-reload, runtime
- **Branch:** `refactor/typescript`（已合入主线语义）

## 背景

主路径曾用 Node `--experimental-strip-types` 直接加载 `.ts`，并用 `HotReloadBase`（chokidar）热更 Core 模块、YAML 与模板。这与「整仓 TypeScript + 可重复构建产物」冲突，且热重载维护成本高、收益低。

## 决策

1. **构建**：`tsc` emit 到 `dist/`；进程启动 **`node dist/app.js`**（或等价），不以 strip-types 作为生产主路径。
2. **源码**：`app`、`src/`、`core/` 迁为 TypeScript；Loader 只加载 **编译后的** Core（`dist/core/...`）。
3. **热重载**：全部移除（模块 / YAML / 模板文件监视）；改配置或代码后 **重启** 生效（改 `.ts` 须先 `pnpm build`）。
4. **范围外**：`subserver/`、独立 www 前端构建语义不变。
5. **命名残留**：`src/infrastructure/plugins/loader-hot-reload.ts` 仅保留 **unload / changePlugin** 等手动换载辅助，**不是** `HotReloadBase`、不含 chokidar 监视。

## 现状核对（2026-09-12）

| 断言 | 代码事实 |
|------|----------|
| 启动主路径 | `package.json`：`start`/`dev` → `pnpm build && node dist/app.js`；无 strip-types |
| 无 HotReloadBase | `src/utils/hot-reload-base.{js,ts}` 不存在；`dist/` 亦无 |
| 无 chokidar | `package.json` dependencies/devDependencies/optionalDependencies 均无 |
| boot 不 watch | `runtime-boot.ts` 无 `PluginLoader.watch` / `HttpApiLoader.watch` 等 |
| 回归测 | `tests/framework/no-hot-reload.test.mjs`（已入 **`pnpm test:fast`**；勿从 fast 摘掉） |
| 运维文档 | [startup.md](../startup.md)「配置与代码变更」→ 本 ADR |

## 后果

- 启动链、`package.json` `#` imports、Docker/CI 增加 `pnpm build`。
- 运维须接受「改 YAML / 源码要重启（+ build）」。
- 详细设计与迁移顺序见 [2026-09-05-typescript-dist-design.md](../superpowers/specs/2026-09-05-typescript-dist-design.md)。

## 相关

[node-26-runtime.md](../node-26-runtime.md) · [coding-style.md](../coding-style.md) · [startup.md](../startup.md) · [0002](./0002-harness-module-first.md)
