import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_RESTART,
  EXIT_STOP,
  SIGNAL_TIME_THRESHOLD_MS,
  SignalTapState,
  handleDoubleTapSignal,
  resolveChildExit
} from '#utils/process-signals.js';

describe('SignalTapState 双击判定', () => {
  it('同信号窗口内为 double tap', () => {
    const state = new SignalTapState();
    state.record('SIGINT', 1000);
    assert.equal(state.isDoubleTap('SIGINT', 1000 + SIGNAL_TIME_THRESHOLD_MS - 1), true);
    assert.equal(state.isDoubleTap('SIGINT', 1000 + SIGNAL_TIME_THRESHOLD_MS + 1), false);
  });

  it('reset 清空状态', () => {
    const state = new SignalTapState();
    state.record('SIGINT');
    state.reset();
    assert.equal(state.lastSignal, null);
  });
});

describe('handleDoubleTapSignal', () => {
  it('第一次 onOnce，第二次 onTwice', async () => {
    const state = new SignalTapState();
    const calls = [];
    await handleDoubleTapSignal('SIGINT', state, {
      onOnce: () => calls.push('once'),
      onTwice: () => calls.push('twice')
    });
    await handleDoubleTapSignal('SIGINT', state, {
      onOnce: () => calls.push('once'),
      onTwice: () => calls.push('twice')
    });
    assert.deepEqual(calls, ['once', 'twice']);
  });
});

describe('resolveChildExit', () => {
  it('exit(1) → 重启；0/130 → 停止', () => {
    assert.equal(resolveChildExit(EXIT_RESTART, null), EXIT_RESTART);
    assert.equal(resolveChildExit(EXIT_STOP, null), EXIT_STOP);
    assert.equal(resolveChildExit(130, null), EXIT_STOP);
  });
});
