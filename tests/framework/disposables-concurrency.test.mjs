/**
 * Disposables / 并发安全完整版
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Disposables } from '#utils/disposables.js';
import {
  runWithRequestContext,
  getRequestContext,
} from '../../src/utils/observability.js';

describe('Disposables 完整版', () => {
  it('dispose 逆序清理 timeout/interval/on', async () => {
    const order = [];
    const d = new Disposables();
    const ee = new EventEmitter();
    d.add(() => order.push('a'));
    d.timeout(() => {}, 60_000);
    d.interval(() => {}, 60_000);
    d.on(ee, 'x', () => {});
    d.add(() => order.push('b'));
    assert.equal(ee.listenerCount('x'), 1);
    d.dispose();
    assert.equal(ee.listenerCount('x'), 0);
    assert.deepEqual(order, ['b', 'a']);
    d.dispose(); // 幂等
  });
});

describe('请求上下文完整版', () => {
  it('嵌套 runWithRequestContext 恢复外层', async () => {
    await runWithRequestContext({ requestId: 'outer' }, async () => {
      assert.equal(getRequestContext()?.requestId, 'outer');
      await runWithRequestContext({ requestId: 'inner' }, async () => {
        assert.equal(getRequestContext()?.requestId, 'inner');
      });
      assert.equal(getRequestContext()?.requestId, 'outer');
    });
  });

  it('并发 50 链互不串写', async () => {
    const out = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runWithRequestContext({ requestId: `c-${i}` }, async () => {
          await new Promise((r) => setTimeout(r, i % 3));
          return getRequestContext()?.requestId;
        })
      )
    );
    assert.deepEqual(out, Array.from({ length: 50 }, (_, i) => `c-${i}`));
  });
});
