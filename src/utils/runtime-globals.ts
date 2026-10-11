/**
 * 运行时全局挂载（globalThis）
 * - Node ESM 下业务代码裸写 AgentRuntime / msgSegment / runtimeConfig 等即解析于此
 * - 见 docs/runtime-surface.md「全局标识符写法」
 */

declare global {
  // eslint-disable-next-line no-var
  var __xrkShuttingDown: boolean | undefined;
}

export function setRuntimeGlobal(name: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[name] = value;
}

export function getRuntimeGlobal<T = unknown>(name: string): T | undefined {
  return (globalThis as Record<string, unknown>)[name] as T | undefined;
}

/** 进程 shutdown 标志（基础设施内部） */
export function isShuttingDown(): boolean {
  return globalThis.__xrkShuttingDown === true;
}

export function setShuttingDown(value = true): void {
  globalThis.__xrkShuttingDown = Boolean(value);
}

/** 一次性进程标志（信号/error handler 等） */
export function isProcessFlagSet(name: string): boolean {
  return (globalThis as Record<string, unknown>)[name] === true;
}

export function setProcessFlag(name: string, value = true): void {
  (globalThis as Record<string, unknown>)[name] = value;
}
