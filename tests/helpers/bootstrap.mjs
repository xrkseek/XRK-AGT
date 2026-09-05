import { EventEmitter } from 'node:events';
import { setRuntimeGlobal, getRuntimeGlobal } from '#utils/runtime-globals.js';

export async function bootstrapTestEnv() {
  process.env.XRK_TEST = '1';
  await import('../../dist/src/bootstrap-globals.js');
  if (!getRuntimeGlobal('logger')) {
    const setLog = (await import('../../dist/src/infrastructure/log.js')).default;
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
