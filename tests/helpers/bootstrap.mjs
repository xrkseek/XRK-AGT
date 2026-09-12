/**
 * 集成/回环测引导：XRK_TEST=1 + dist bootstrap-globals（PluginBase / msgSegment）
 * 与生产一致：agent-runtime 首行 import bootstrap-globals；测试走编译产物 dist/，勿 import src/。
 * @see docs/runtime-surface.md「框架单测 / 集成测」· docs/框架测试指南.md
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setRuntimeGlobal, getRuntimeGlobal } from '#utils/runtime-globals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** 测试必须对齐 dist（package.json `#*` → dist）；非 ts 源路径 */
const BOOTSTRAP_GLOBALS_JS = path.join(root, 'dist/src/bootstrap-globals.js');
const LOG_JS = path.join(root, 'dist/src/infrastructure/log.js');

export async function bootstrapTestEnv() {
  process.env.XRK_TEST = '1';

  if (!fs.existsSync(BOOTSTRAP_GLOBALS_JS)) {
    throw new Error(
      `缺少 ${BOOTSTRAP_GLOBALS_JS}；请先 pnpm build（测试 import dist bootstrap-globals，非 src）`,
    );
  }
  await import(pathToFileURL(BOOTSTRAP_GLOBALS_JS).href);

  if (typeof getRuntimeGlobal('PluginBase') !== 'function') {
    throw new Error('dist bootstrap-globals 未挂载 PluginBase（globalThis）');
  }
  const seg = getRuntimeGlobal('msgSegment');
  if (!seg || typeof seg !== 'object') {
    throw new Error('dist bootstrap-globals 未挂载 msgSegment（globalThis）');
  }

  if (!getRuntimeGlobal('logger')) {
    if (!fs.existsSync(LOG_JS)) {
      throw new Error(`缺少 ${LOG_JS}；请先 pnpm build`);
    }
    const setLog = (await import(pathToFileURL(LOG_JS).href)).default;
    setLog();
  }

  const runtime = getRuntimeGlobal('AgentRuntime');
  if (!runtime || typeof runtime.on !== 'function') {
    const stub = new EventEmitter();
    stub.makeLog = () => {};
    stub.tasker = [];
    stub.mkdir = async () => {};
    stub.em = () => stub;
    setRuntimeGlobal('AgentRuntime', stub);
  }
}
