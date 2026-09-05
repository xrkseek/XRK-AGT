/**
 * 入站 HTTP 延迟聚合（生产中间件 + /metrics 导出）
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createHttpRequestMetricsMiddleware,
  getHttpRequestMetricsSummary,
  resetHttpRequestMetrics,
  recordHttpRequest,
} from '#utils/http-request-metrics.js';
import {
  buildProcessMetrics,
  formatPrometheusMetrics,
} from '#utils/observability.js';

function mockRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

describe('http-request-metrics', () => {
  beforeEach(() => {
    resetHttpRequestMetrics();
  });

  it('record 后 summary 含 R-7 百分位与水库标记', () => {
    for (let i = 1; i <= 50; i++) {
      recordHttpRequest({ ok: true, ms: i, status: 200 });
    }
    const s = getHttpRequestMetricsSummary();
    assert.equal(s.total, 50);
    assert.equal(s.reservoir, true);
    assert.ok(s.latencyMs.p50 > 0);
    assert.ok(s.latencyMs.p99 >= s.latencyMs.p50);
  });

  it('中间件 finish 记账；跳过 /metrics', async () => {
    const mw = createHttpRequestMetricsMiddleware();
    await new Promise((resolve) => {
      const res = mockRes(200);
      mw({ path: '/health' }, res, () => {
        res.emit('finish');
        resolve();
      });
    });
    await new Promise((resolve) => {
      const res = mockRes(200);
      mw({ path: '/metrics' }, res, () => {
        res.emit('finish');
        resolve();
      });
    });
    const s = getHttpRequestMetricsSummary();
    assert.equal(s.total, 1);
  });

  it('5xx 计入 fail；buildProcessMetrics / Prometheus 导出 http', () => {
    recordHttpRequest({ ok: true, ms: 10, status: 200 });
    recordHttpRequest({ ok: false, ms: 20, status: 503 });
    const http = getHttpRequestMetricsSummary();
    const metrics = buildProcessMetrics({ http });
    assert.equal(metrics.http.fail, 1);
    const text = formatPrometheusMetrics(metrics);
    assert.match(text, /xrk_http_requests_total 2/);
    assert.match(text, /xrk_http_latency_ms_p99/);
  });
});
