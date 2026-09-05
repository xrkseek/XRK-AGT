# ADR-0004: TypeScript 编译至 dist，并移除热重载

- **Status:** Proposed
- **Date:** 2026-09-05
- **Tags:** typescript, build, hot-reload, runtime
- **Branch:** `refactor/typescript`

## 背景

主路径曾用 Node `--experimental-strip-types` 直接加载 `.ts`，并用 `HotReloadBase`（chokidar）热更 Core 模块、YAML 与模板。这与「整仓 TypeScript + 可重复构建产物」冲突，且热重载维护成本高、收益低。

## 决策

1. **构建**：`tsc` emit 到 `dist/`；进程启动 **`node dist/app.js`**（或等价），不以 strip-types 作为生产主路径。
2. **源码**：`app`、`src/`、`core/` 迁为 TypeScript；Loader 只加载 **编译后的** Core。
3. **热重载**：全部移除（模块 / YAML / 模板）；改配置或代码后 **重启** 生效。
4. **范围外**：`subserver/`、独立 www 前端构建语义不变。

## 后果

- 启动链、`package.json` `#` imports、Docker/CI 增加 `pnpm build`。
- 删除 `HotReloadBase` 与相关文档约定；运维需接受「改 YAML 要重启」。
- 详细设计与迁移顺序见 [2026-09-05-typescript-dist-design.md](../superpowers/specs/2026-09-05-typescript-dist-design.md)。

## 相关

[node-26-runtime.md](../node-26-runtime.md) · [coding-style.md](../coding-style.md) · [0002](./0002-harness-module-first.md)
