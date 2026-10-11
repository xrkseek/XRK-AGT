import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserVisibleTurnState } from '#utils/chat-user-visible-ack.js';

/** 单次 workflow.execute / callAI 异步链上的 turn 状态（可含斜杠短路标记） */
export type WorkflowTurnState = UserVisibleTurnState & {
  slashShortCircuit?: boolean;
};

/** 单次请求 ALS：会话事件、turn、工具流白名单（并发消息互不干扰） */
export type WorkflowRequestContext = {
  e?: unknown;
  turnState?: WorkflowTurnState | null;
  toolStreamNames?: string[];
};

const workflowRequestAls = new AsyncLocalStorage<WorkflowRequestContext>();

export function runWithWorkflowRequestContext<T>(
  ctx: WorkflowRequestContext,
  fn: () => T,
): T {
  return workflowRequestAls.run(ctx, fn);
}

export function getWorkflowRequestContext(): WorkflowRequestContext | null {
  return workflowRequestAls.getStore() ?? null;
}
