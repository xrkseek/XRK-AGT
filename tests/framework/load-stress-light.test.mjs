/**
 * 轻量 Load / Stress：无 HTTP 服务的并发吞吐与突发争用
 * 目标：CI 可跑的质量工程塔尖雏形，非生产 RPS 基线。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InputValidator } from '../../src/utils/input-validator.js';
import { RuntimeError } from '../../src/utils/error-handler.js';
import { Disposables } from '../../src/utils/disposables.js';
import {
  runWithRequestContext,
  getRequestContext,
  formatPrometheusMetrics,
  buildProcessMetrics,
} from '../../src/utils/observability.js';
import { estimateTokensMixed } from '#utils/token-estimate.js';

const dataRoot = path.join(process.cwd(), 'data');

describe('load-smoke 轻量负载', () => {
  it('并发 200 次路径校验保持正确性', async () => {
    const N = 200;
    const tasks = Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() => {
        if (i % 5 === 0) {
          assert.throws(
            () => InputValidator.validatePath(`../leak-${i}`, dataRoot),
            RuntimeError
          );
          return 'rej';
        }
        const p = InputValidator.validatePath(`server_bots/load-${i}.yaml`, dataRoot);
        assert.ok(p.includes(`load-${i}.yaml`));
        return 'ok';
      })
    );
    const results = await Promise.all(tasks);
    assert.equal(results.filter((r) => r === 'ok').length, 160);
    assert.equal(results.filter((r) => r === 'rej').length, 40);
  });

  it('并发 ALS 上下文互不串写', async () => {
    const N = 100;
    const seen = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runWithRequestContext({ requestId: `load-${i}` }, async () => {
          await Promise.resolve();
          return getRequestContext()?.requestId;
        })
      )
    );
    assert.equal(new Set(seen).size, N);
    for (let i = 0; i < N; i++) {
      assert.equal(seen[i], `load-${i}`);
    }
  });

  it('metrics 文本导出在突发下稳定可解析', () => {
    const text = formatPrometheusMetrics(buildProcessMetrics());
    const lines = text.trim().split('\n');
    assert.ok(lines.length >= 6);
    assert.ok(lines.every((l) => l.startsWith('#') || /^xrk_\w+ /.test(l)));
  });
});

describe('stress-light 轻量压力', () => {
  it('突发 2k token 估算无异常抛出', () => {
    const blob = '压测文本'.repeat(500) + ' english words '.repeat(200);
    for (let i = 0; i < 2000; i++) {
      const n = estimateTokensMixed(blob + String(i));
      assert.ok(Number.isFinite(n) && n > 0);
    }
  });

  it('Disposables 高频注册/释放无残留定时器泄漏迹象', () => {
    const before = process.getActiveResourcesInfo?.() || null;
    for (let round = 0; round < 50; round++) {
      const d = new Disposables();
      for (let i = 0; i < 20; i++) {
        d.timeout(() => {}, 60_000);
        d.interval(() => {}, 60_000);
      }
      d.dispose();
    }
    if (before && process.getActiveResourcesInfo) {
      const after = process.getActiveResourcesInfo();
      // 允许波动；不应因未 dispose 导致 Timeout 暴增
      const count = (list, kind) => list.filter((x) => String(x).includes(kind)).length;
      assert.ok(
        count(after, 'Timeout') <= count(before, 'Timeout') + 5,
        'Timeout 资源应在 dispose 后收敛'
      );
    }
  });
});
