/**
 * 生产级延迟统计算法：R-7 百分位 / Welford / 水库 / SLO
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  percentileR7,
  WelfordAccumulator,
  ReservoirSampler,
  LatencyHistogram,
  evaluateSlo
} from '../../src/utils/metrics-stats.js';
import { mulberry32, exponentialDelayMs } from '#utils/prng.js';

describe('percentileR7 (Hyndman–Fan)', () => {
  it('空/单点/端点', () => {
    assert.equal(percentileR7([], 50), 0);
    assert.equal(percentileR7([7], 99), 7);
    assert.equal(percentileR7([1, 2, 3, 4], 0), 1);
    assert.equal(percentileR7([1, 2, 3, 4], 100), 4);
  });

  it('均匀样本 p50 为中位插值', () => {
    const s = [1, 2, 3, 4, 5];
    assert.equal(percentileR7(s, 50), 3);
    // n=100, p99 应贴近高端而非 ceil 索引跳变
    const u = Array.from({ length: 100 }, (_, i) => i + 1);
    const p99 = percentileR7(u, 99);
    assert.ok(p99 > 98.5 && p99 < 99.5, `p99=${p99}`);
  });
});

describe('WelfordAccumulator', () => {
  it('均值与样本方差正确', () => {
    const w = new WelfordAccumulator();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) w.push(x);
    assert.equal(w.count, 8);
    assert.ok(Math.abs(w.mean - 5) < 1e-9);
    // 样本方差 Σ(x-μ)²/(n-1) = 32/7
    assert.ok(Math.abs(w.variance - 32 / 7) < 1e-9);
  });
});

describe('ReservoirSampler', () => {
  it('容量有界且 seen 完整', () => {
    const r = new ReservoirSampler(10);
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) r.push(i, rng);
    assert.equal(r.samples.length, 10);
    assert.equal(r.seen, 1000);
  });
});

describe('LatencyHistogram', () => {
  it('全量模式：stddev + R-7 百分位', () => {
    const h = new LatencyHistogram();
    h.begin();
    for (let i = 1; i <= 100; i++) {
      h.record({ ok: i !== 100, ms: i, status: i === 100 ? 500 : 200 });
    }
    h.end();
    const s = h.summary();
    assert.equal(s.total, 100);
    assert.equal(s.fail, 1);
    assert.ok(s.latencyMs.stddev > 0);
    assert.ok(s.latencyMs.p50 >= 49 && s.latencyMs.p50 <= 51);
    assert.ok(s.latencyMs.p99 >= 98);
    assert.equal(s.reservoir, false);
  });

  it('水库模式：样本有界、observedCount 增长', () => {
    const h = new LatencyHistogram({ reservoirSize: 50, slidingWindow: 40 });
    h.begin();
    for (let i = 0; i < 500; i++) {
      h.record({ ok: i % 10 !== 0, ms: (i % 40) + 1, status: 200 });
    }
    h.end();
    const s = h.summary();
    assert.equal(s.reservoir, true);
    assert.equal(s.sampleCount, 50);
    assert.equal(s.observedCount, 500);
    assert.ok(s.slidingErrorRate >= 0);
    assert.ok(s.latencyMs.p95 >= s.latencyMs.p50);
  });
});

describe('evaluateSlo', () => {
  it('支持 slidingErrorRate / minSamples', () => {
    const summary = {
      total: 100,
      ok: 90,
      fail: 10,
      errorRate: 0.1,
      slidingErrorRate: 0.25,
      sampleCount: 40,
      elapsedMs: 1000,
      rps: 100,
      latencyMs: { min: 1, avg: 5, stddev: 1, p50: 4, p90: 8, p95: 9, p99: 12, max: 20 }
    };
    const bad = evaluateSlo(summary, {
      maxSlidingErrorRate: 0.15,
      minSamples: 100
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.violations.some((v) => v.includes('sliding')));
    assert.ok(bad.violations.some((v) => v.includes('samples')));
  });
});

describe('prng / exponentialDelay', () => {
  it('同种子可复现', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    assert.deepEqual(seqA, seqB);
  });

  it('指数延迟截断到 cap', () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const d = exponentialDelayMs(10, 30, rng);
      assert.ok(d >= 0 && d <= 30);
    }
  });
});
