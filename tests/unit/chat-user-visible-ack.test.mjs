import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserVisibleTurnState,
  formatReplySentAck,
  formatReplyQueuedAck,
  isOverlappingUserVisible
} from '#utils/chat-user-visible-ack.js';

describe('chat user-visible ack', () => {
  it('createUserVisibleTurnState 含 reply 队列与 flushed 字段', () => {
    const turn = createUserVisibleTurnState();
    assert.equal(turn.queuedReplyContent, '');
    assert.equal(turn.queuedReplyMessageId, null);
    assert.equal(turn.replyFlushed, false);
    assert.equal(turn.lastOutboundSummary, '');
  });

  it('reply sent ack 表示已立即发到会话', () => {
    const ack = formatReplySentAck('群 1', '你好', '99');
    assert.match(ack, /你已通过 reply 向群 1发出/);
    assert.match(ack, /引用消息 99/);
    assert.match(ack, /用户在 QQ 里已能看到/);
    assert.match(ack, /已送达/);
  });

  it('queued ack 别名与 sent ack 一致', () => {
    assert.equal(
      formatReplyQueuedAck('群 1', '你好', '99'),
      formatReplySentAck('群 1', '你好', '99')
    );
  });

  it('overlap detects repeat reply text', () => {
    assert.equal(isOverlappingUserVisible('你好呀', '你好呀'), true);
  });
});
