/**
 * AiWorkflowLoader 宿主解析：打断 PluginBase / AiWorkflow ↔ loader 顶层循环依赖。
 * loader 单例构造后调用 setAiWorkflowHost(instance)。
 */
import { setRuntimeGlobal } from '#utils/runtime-globals.js';

let host: unknown = null;

export function setAiWorkflowHost(instance: unknown): void {
  host = instance || null;
  if (host) setRuntimeGlobal('AiWorkflowLoader', host);
}

export function getAiWorkflowHost(): unknown {
  return host || (globalThis as { AiWorkflowLoader?: unknown }).AiWorkflowLoader || null;
}
