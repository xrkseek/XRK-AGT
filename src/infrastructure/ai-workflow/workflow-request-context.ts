import { AsyncLocalStorage } from 'node:async_hooks';

/** 单次 workflow.execute / callAI 异步链上的会话与 turn 状态（并发消息互不干扰） */
const workflowRequestAls = new AsyncLocalStorage<Record<string, unknown>>();

export function runWithWorkflowRequestContext<T>(
  ctx: Record<string, unknown>,
  fn: () => T,
): T {
  return workflowRequestAls.run(ctx, fn);
}

export function getWorkflowRequestContext(): Record<string, unknown> | null {
  return workflowRequestAls.getStore() ?? null;
}
