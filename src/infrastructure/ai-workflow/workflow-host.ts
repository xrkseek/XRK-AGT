/**
 * AiWorkflowLoader 宿主解析：打断 PluginBase / AiWorkflow ↔ loader 顶层循环依赖。
 * loader 单例构造后调用 setAiWorkflowHost(instance)。
 */
import { setRuntimeGlobal } from '#utils/runtime-globals.js';

/** 插件 / AiWorkflow 侧只需的最小宿主面 */
export type AiWorkflowHost = {
  getWorkflow?: (name: string) => unknown;
  mergeWorkflows?: (options: {
    name?: string;
    main: string;
    secondary?: string[];
    prefixSecondary?: boolean;
    description?: string;
  }) => unknown;
  workflows?: Map<string, unknown>;
};

let host: AiWorkflowHost | null = null;

export function setAiWorkflowHost(instance: unknown): void {
  host =
    instance && typeof instance === 'object'
      ? (instance as AiWorkflowHost)
      : null;
  if (host) setRuntimeGlobal('AiWorkflowLoader', host);
}

export function getAiWorkflowHost(): AiWorkflowHost | null {
  if (host) return host;
  const g = (globalThis as { AiWorkflowLoader?: unknown }).AiWorkflowLoader;
  if (g && typeof g === 'object') return g as AiWorkflowHost;
  return null;
}
