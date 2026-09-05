/**
 * 质量金字塔轻量门禁（CI 可跑）：
 * smoke / load / stress / soak / bench / chaos 的无 HTTP 自举版。
 * 生产级 HTTP 压测仍走 tests/perf/run-perf.mjs。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { InputValidator } from '../../src/utils/input-validator.js';
import { RuntimeError } from '../../src/utils/error-handler.js';
import { Disposables } from '#utils/disposables.js';
import {
  runWithRequestContext,
  getRequestContext,
  formatPrometheusMetrics,
  buildProcessMetrics
} from '../../src/utils/observability.js';
import {
  LatencyHistogram,
  evaluateSlo
} from '../perf/lib/stats.mjs';
import {
  buildOpenAIVisionParts,
  extractVisionFromSegments
} from '../../src/utils/llm/vision-content.js';

const dataRoot = path.join(process.cwd(), 'data');

function microWork(i) {
  const t0 = performance.now();
  if (i % 7 === 0) {
    try {
      InputValidator.validatePath(`../chaos-${i}`, dataRoot);
    } catch {
      /* expected */
    }
  } else {
    InputValidator.validatePath(`server_bots/q-${i}.yaml`, dataRoot);
  }
  extractVisionFromSegments([
    { type: 'image', file: `f${i}.jpg` },
    { type: 'text', text: 'x' }
  ]);
  return performance.now() - t0;
}

describe('smoke-light 冒烟门禁', () => {
  it('直方图 + SLO：短突发满足宽松门槛', async () => {
    const h = new LatencyHistogram();
    h.begin();
    await Promise.all(
      Array.from({ length: 80 }, async (_, i) => {
        const ms = microWork(i);
        h.record({ ok: true, ms, status: 200 });
      })
    );
    h.end();
    const summary = h.summary();
    const slo = evaluateSlo(summary, { maxP99Ms: 80, maxErrorRate: 0.01, minRps: 20 });
    assert.equal(slo.ok, true, slo.violations.join('; '));
    assert.equal(summary.fail, 0);
  });
});

describe('load-light 负载', () => {
  it('并发 300 路径校验无串台', async () => {
    const N = 300;
    const seen = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runWithRequestContext({ requestId: `L${i}` }, async () => {
          microWork(i);
          return getRequestContext()?.requestId;
        })
      )
    );
    assert.equal(new Set(seen).size, N);
  });
});

describe('stress-light 压力', () => {
  it('连续 3k 次 vision parts 构建无异常', () => {
    for (let i = 0; i < 3000; i++) {
      const parts = buildOpenAIVisionParts(
        {
          text: `t${i}`,
          images: [`http://a/${i}`, `http://b/${i}`],
          replyImages: i % 2 === 0 ? [`http://r/${i}`] : []
        },
        { visionMaxImages: 8 }
      );
      assert.ok(parts.length >= 1);
    }
  });
});

describe('soak-light 浸泡雏形', () => {
  it('约 1.2s 循环：水库直方图内存有界 + ALS/metrics 无泄漏迹象', async () => {
    const hist = new LatencyHistogram({ reservoirSize: 128, slidingWindow: 64 });
    hist.begin();
    const end = Date.now() + 1200;
    let rounds = 0;
    const before = process.memoryUsage().heapUsed;
    while (Date.now() < end) {
      rounds += 1;
      const d = new Disposables();
      d.timeout(() => {}, 5);
      await runWithRequestContext({ requestId: `soak-${rounds}` }, async () => {
        const ms = microWork(rounds);
        hist.record({ ok: rounds % 17 !== 0, ms, status: 200 });
        formatPrometheusMetrics(buildProcessMetrics());
      });
      d.dispose();
    }
    hist.end();
    const s = hist.summary();
    assert.ok(rounds >= 20, `rounds=${rounds}`);
    assert.equal(s.reservoir, true);
    assert.ok(s.sampleCount <= 128);
    assert.equal(s.observedCount, rounds);
    assert.ok(s.latencyMs.stddev >= 0);
    const after = process.memoryUsage().heapUsed;
    // 允许抖动，但不允许无限膨胀（>80MB 视为异常）
    assert.ok(after - before < 80 * 1024 * 1024, `heapΔ=${after - before}`);
  });
});

describe('bench-light 基准雏形', () => {
  it('记录 p50/p99 并导出 summary', () => {
    const h = new LatencyHistogram();
    h.begin();
    for (let i = 0; i < 500; i++) {
      h.record({ ok: true, ms: microWork(i), status: 200 });
    }
    h.end();
    const s = h.summary();
    assert.ok(s.latencyMs.p50 <= s.latencyMs.p99);
    assert.ok(s.latencyMs.p99 <= s.latencyMs.max);
    assert.ok(s.rps > 0);
  });
});

describe('chaos-light 混沌雏形', () => {
  it('注入约 12% 失败后 errorRate 可观测且 SLO 可判定', () => {
    const h = new LatencyHistogram();
    h.begin();
    const N = 200;
    for (let i = 0; i < N; i++) {
      const fail = i % 8 === 0;
      const ms = microWork(i);
      if (fail) {
        h.record({ ok: false, ms, status: 500 });
      } else {
        h.record({ ok: true, ms, status: 200 });
      }
    }
    h.end();
    const summary = h.summary();
    assert.ok(summary.errorRate > 0.1 && summary.errorRate < 0.15);
    const loose = evaluateSlo(summary, { maxErrorRate: 0.2 });
    assert.equal(loose.ok, true);
    const tight = evaluateSlo(summary, { maxErrorRate: 0.05 });
    assert.equal(tight.ok, false);
    assert.ok(tight.violations.some((v) => v.includes('errorRate')));
  });

  it('路径穿越在混沌采样下仍稳定拒绝', () => {
    for (let i = 0; i < 50; i++) {
      assert.throws(
        () => InputValidator.validatePath(`../chaos/${i}/../x`, dataRoot),
        RuntimeError
      );
    }
  });
});
