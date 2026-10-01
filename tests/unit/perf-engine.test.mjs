/**
 * 压测引擎单元测（不启 AgentRuntime；本地微型 HTTP）
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LatencyHistogram, evaluateSlo } from '../perf/lib/stats.mjs';
import {
  runDurationLoad,
  runFixedBenchmark,
  runStressRamp,
} from '../perf/lib/http-bench.mjs';
import { TARGETS, weightedPicker, buildRequest } from '../perf/lib/targets.mjs';

describe('perf stats', () => {
  it('百分位与 errorRate 计算正确', () => {
    const h = new LatencyHistogram();
    h.begin();
    for (let i = 1; i <= 100; i++) {
      h.record({ ok: i !== 100, ms: i, status: i === 100 ? 500 : 200 });
    }
    h.end();
    const s = h.summary();
    assert.equal(s.total, 100);
    assert.equal(s.fail, 1);
    assert.ok(s.errorRate > 0 && s.errorRate < 0.02);
    assert.ok(s.latencyMs.p50 >= 40 && s.latencyMs.p50 <= 60);
    assert.ok(s.latencyMs.p99 >= 90);
  });

  it('evaluateSlo 能检出违规', () => {
    const summary = {
      total: 10,
      ok: 8,
      fail: 2,
      errorRate: 0.2,
      elapsedMs: 1000,
      rps: 10,
      latencyMs: { min: 1, avg: 5, p50: 4, p90: 8, p95: 9, p99: 50, max: 50 },
      statusCounts: {},
      bytesIn: 0,
    };
    const bad = evaluateSlo(summary, { maxP99Ms: 20, maxErrorRate: 0.05 });
    assert.equal(bad.ok, false);
    assert.ok(bad.violations.length >= 2);
    const good = evaluateSlo(summary, { maxP99Ms: 100, maxErrorRate: 0.5, minRps: 5 });
    assert.equal(good.ok, true);
  });
});

describe('perf targets', () => {
  it('weightedPicker 只返回已注册目标', () => {
    const pick = weightedPicker([
      { id: 'health', weight: 3 },
      { id: 'metrics', weight: 1 },
    ]);
    for (let i = 0; i < 20; i++) {
      const t = pick();
      assert.ok(t.id === 'health' || t.id === 'metrics');
    }
  });

  it('buildRequest 鉴权目标带 X-API-Key', () => {
    const req = buildRequest('http://127.0.0.1:1', TARGETS.api_health, { apiKey: 'k' });
    assert.equal(req.headers['x-api-key'], 'k');
    assert.match(req.url, /\/api\/health$/);
  });
});

describe('perf http-bench（本地微型服务器）', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {number} */
  let port;

  before(async () => {
    let hits = 0;
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === '/slow' && hits % 7 === 0) {
        res.writeHead(503);
        res.end('no');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('runFixedBenchmark 完成请求计数', async () => {
    const hist = await runFixedBenchmark({
      totalRequests: 40,
      concurrency: 8,
      buildRequest: () => ({
        url: `http://127.0.0.1:${port}/ok`,
        expectStatus: 200,
        timeoutMs: 3000,
      }),
    });
    const s = hist.summary();
    assert.equal(s.total, 40);
    assert.equal(s.ok, 40);
    assert.ok(s.rps > 0);
  });

  it('runDurationLoad 按时长产出样本', async () => {
    const hist = await runDurationLoad({
      concurrency: 5,
      durationMs: 400,
      buildRequest: () => ({
        url: `http://127.0.0.1:${port}/ok`,
        expectStatus: 200,
        timeoutMs: 3000,
      }),
    });
    assert.ok(hist.summary().total >= 5);
  });

  it('runStressRamp 能推进阶梯', async () => {
    const result = await runStressRamp({
      startConcurrency: 2,
      maxConcurrency: 6,
      step: 2,
      stepDurationMs: 250,
      slo: { maxP99Ms: 5000, maxErrorRate: 0.5 },
      buildRequest: () => ({
        url: `http://127.0.0.1:${port}/ok`,
        expectStatus: 200,
        timeoutMs: 3000,
      }),
    });
    assert.ok(result.steps.length >= 2);
    assert.equal(result.brokeAt, null);
  });
});
