/**
 * 可观测性：Request-Id / ALS / Span / Prometheus / 子服探活
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRequestId,
  enterRequestContext,
  getRequestContext,
  runWithRequestContext,
  createSpan,
  formatPrometheusMetrics,
  buildProcessMetrics,
  probeSubserverHealth,
  buildReadinessSnapshot,
} from '#utils/observability.js';

describe('observability', () => {
  it('resolveRequestId 优先入站 X-Request-Id', () => {
    const id = resolveRequestId({
      headers: { 'x-request-id': 'client-trace-1' },
    });
    assert.equal(id, 'client-trace-1');
  });

  it('resolveRequestId 回退生成非空 id', () => {
    const id = resolveRequestId({ headers: {} });
    assert.ok(typeof id === 'string' && id.length > 4);
  });

  it('enterRequestContext 可被 getRequestContext 读到', () => {
    enterRequestContext({ requestId: 'r-als', path: '/x', method: 'GET' });
    assert.equal(getRequestContext()?.requestId, 'r-als');
  });

  it('runWithRequestContext 隔离内外上下文', () => {
    enterRequestContext({ requestId: 'outer' });
    runWithRequestContext({ requestId: 'inner' }, () => {
      assert.equal(getRequestContext()?.requestId, 'inner');
    });
    assert.equal(getRequestContext()?.requestId, 'outer');
  });

  it('createSpan.end 返回耗时毫秒', () => {
    const span = createSpan('unit-test');
    const ms = span.end({ ok: true });
    assert.ok(Number.isFinite(ms) && ms >= 0);
  });

  it('formatPrometheusMetrics 含 HELP/TYPE 与堆指标', () => {
    const text = formatPrometheusMetrics(
      buildProcessMetrics({
        workflow: { traces: { total: 3, failed: 1 }, avgDurationMs: 12.5 },
      })
    );
    assert.match(text, /# HELP xrk_nodejs_heap_used_bytes/);
    assert.match(text, /# TYPE xrk_nodejs_heap_used_bytes gauge/);
    assert.match(text, /xrk_workflow_traces_total 3/);
    assert.match(text, /xrk_workflow_traces_failed 1/);
  });

  it('probeSubserverHealth 用 mock fetch 标记 operational', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200 });
    const snap = await probeSubserverHealth({ fetchImpl, timeoutMs: 200 });
    assert.equal(snap.status, 'operational');
    assert.ok(snap.runtimes && Object.keys(snap.runtimes).length > 0);
    for (const v of Object.values(snap.runtimes)) {
      assert.equal(v.status, 'operational');
    }
  });

  it('probeSubserverHealth 全部失败为 unavailable', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const snap = await probeSubserverHealth({ fetchImpl, timeoutMs: 50 });
    assert.equal(snap.status, 'unavailable');
  });

  it('buildReadinessSnapshot 子服失败不拖垮 Redis 以外的 healthy 门槛', async () => {
    const fetchImpl = async () => {
      throw new Error('down');
    };
    const snap = await buildReadinessSnapshot({
      includeLoaders: false,
      includeMcp: false,
      includeSubservers: true,
      subserverFetch: fetchImpl,
      agentRuntime: null,
    });
    assert.ok(snap.services.subservers);
    assert.equal(snap.services.subservers.status, 'unavailable');
    // Redis 若可用则 overall 不应因子服 unavailable 变 unhealthy
    if (snap.services.redis === 'operational') {
      assert.notEqual(snap.status, 'unhealthy');
    }
  });
});
