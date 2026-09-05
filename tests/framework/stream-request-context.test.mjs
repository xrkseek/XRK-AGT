import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runWithWorkflowRequestContext,
  getWorkflowRequestContext
} from '../../src/infrastructure/ai-workflow/workflow-request-context.js';
import { createUserVisibleTurnState } from '#utils/chat-user-visible-ack.js';

describe('workflow request context', () => {
  it('isolates turnState between concurrent async chains', async () => {
    const results = await Promise.all([
      runWithWorkflowRequestContext({ e: { id: 'a' }, turnState: createUserVisibleTurnState() }, async () => {
        const turn = getWorkflowRequestContext().turnState;
        turn.queuedReplyContent = 'reply-a';
        await new Promise((r) => setTimeout(r, 20));
        return turn.queuedReplyContent;
      }),
      runWithWorkflowRequestContext({ e: { id: 'b' }, turnState: createUserVisibleTurnState() }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        const turn = getWorkflowRequestContext().turnState;
        return turn.queuedReplyContent || 'empty';
      })
    ]);
    assert.equal(results[0], 'reply-a');
    assert.equal(results[1], 'empty');
  });
});
