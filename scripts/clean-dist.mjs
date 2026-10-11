/**
 * 构建前清空 dist/。
 *
 * 为什么必须清：tsc 只写新产物、从不删旧文件，copy-runtime-assets 只覆盖同名文件。
 * 两者叠加的后果是「源码已删、dist 仍在」——已删模块的 .js/.map 作为幽灵产物留在
 * dist 里，集成与 e2e 测试会 import 到它们并通过（假绿），或让 dist 与 src 长期漂移。
 * 真实案例：删除 src/utils/segment-plaintext.ts 后，dist/src/utils/segment-plaintext.js
 * 仍在，测试与启动都不会报错，只是悄悄用着一份没人再维护的实现。
 *
 * 代价是 tsc 没有增量缓存（tsconfig.build.json 未开 incremental），每次全量编译；
 * 换来的是「dist 必然等于 src」。build:watch 刻意不接本脚本，避免每次重启都清空。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

await fs.rm(dist, { recursive: true, force: true });
console.log('clean-dist: 已清空 dist/');
