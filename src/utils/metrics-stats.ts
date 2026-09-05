/**
 * 延迟 / 吞吐 / 错误率统计原语
 * 供 HTTP 入站指标、perf gate、`evaluateSlo` 共用。
 */

/**
 * R-7 连续百分位（已排序升序数组）
 */
export function percentileR7(sortedAsc: number[] | null | undefined, p: number): number {
  const n = sortedAsc?.length || 0;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc![0]!;
  const clamped = Math.min(100, Math.max(0, Number(p) || 0));
  if (clamped <= 0) return sortedAsc![0]!;
  if (clamped >= 100) return sortedAsc![n - 1]!;
  const h = ((n - 1) * clamped) / 100;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const w = h - lo;
  return sortedAsc![lo]! * (1 - w) + sortedAsc![hi]! * w;
}

/** 在线均值 / 样本方差（Welford） */
export class WelfordAccumulator {
  count = 0;
  mean = 0;
  m2 = 0;

  push(x: number): void {
    const v = Number(x);
    if (!Number.isFinite(v)) return;
    this.count += 1;
    const d = v - this.mean;
    this.mean += d / this.count;
    this.m2 += d * (v - this.mean);
  }

  get variance(): number {
    return this.count > 1 ? this.m2 / (this.count - 1) : 0;
  }

  get stddev(): number {
    return Math.sqrt(this.variance);
  }

  snapshot(): { count: number; mean: number; variance: number; stddev: number } {
    return {
      count: this.count,
      mean: this.mean,
      variance: this.variance,
      stddev: this.stddev,
    };
  }
}

/**
 * 算法 R 水库采样：固定容量，对全量流无偏近似分位数
 */
export class ReservoirSampler {
  capacity: number;
  samples: number[];
  seen: number;

  constructor(capacity = 10_000) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.samples = [];
    this.seen = 0;
  }

  push(x: number, rng: () => number = Math.random): void {
    const v = Number(x);
    if (!Number.isFinite(v)) return;
    this.seen += 1;
    if (this.samples.length < this.capacity) {
      this.samples.push(v);
      return;
    }
    const j = Math.floor(rng() * this.seen);
    if (j < this.capacity) this.samples[j] = v;
  }
}

/** 环形滑动窗口错误率 */
export class SlidingErrorWindow {
  size: number;
  buf: Uint8Array;
  i: number;
  filled: number;
  failInWindow: number;

  constructor(size = 200) {
    this.size = Math.max(1, Math.floor(size));
    this.buf = new Uint8Array(this.size);
    this.i = 0;
    this.filled = 0;
    this.failInWindow = 0;
  }

  push(ok: boolean): void {
    const fail = ok ? 0 : 1;
    if (this.filled === this.size) {
      this.failInWindow -= this.buf[this.i]!;
    } else {
      this.filled += 1;
    }
    this.buf[this.i] = fail;
    this.failInWindow += fail;
    this.i = (this.i + 1) % this.size;
  }

  get errorRate(): number {
    return this.filled === 0 ? 0 : this.failInWindow / this.filled;
  }
}

export type LatencyRecord = {
  ok: boolean;
  ms: number;
  status?: number;
  bytes?: number;
};

export type LatencySummary = {
  total: number;
  ok: number;
  fail: number;
  errorRate: number;
  slidingErrorRate: number;
  elapsedMs: number;
  rps: number;
  sampleCount: number;
  observedCount: number;
  reservoir: boolean;
  latencyMs: {
    min: number;
    avg: number;
    stddev: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  statusCounts: Record<string | number, number>;
  bytesIn: number;
};

/**
 * 延迟直方图摘要（可选水库 + 滑动错误窗）
 * `summary()` 产出 p50/p90/p95/p99、rps、errorRate 等。
 */
export class LatencyHistogram {
  _reservoir: ReservoirSampler | null;
  samples: number[];
  ok: number;
  fail: number;
  statusCounts: Record<string | number, number>;
  bytesIn: number;
  startMs: number;
  endMs: number;
  welford: WelfordAccumulator;
  sliding: SlidingErrorWindow | null;
  minMs: number;
  maxMs: number;

  /**
   * @param opts.reservoirSize 为 null/0 时全量保留 samples
   */
  constructor(opts: { reservoirSize?: number | null; slidingWindow?: number } = {}) {
    const rs = opts.reservoirSize;
    this._reservoir =
      rs == null || rs === 0 ? null : new ReservoirSampler(Number(rs) || 10_000);
    this.samples = [];
    this.ok = 0;
    this.fail = 0;
    this.statusCounts = Object.create(null) as Record<string | number, number>;
    this.bytesIn = 0;
    this.startMs = 0;
    this.endMs = 0;
    this.welford = new WelfordAccumulator();
    this.sliding =
      opts.slidingWindow != null && opts.slidingWindow > 0
        ? new SlidingErrorWindow(opts.slidingWindow)
        : null;
    this.minMs = Infinity;
    this.maxMs = -Infinity;
  }

  begin(): void {
    this.startMs = Date.now();
  }

  end(): void {
    this.endMs = Date.now();
  }

  record(row: LatencyRecord): void {
    const ms = Number(row?.ms);
    if (Number.isFinite(ms)) {
      if (this._reservoir) this._reservoir.push(ms);
      else this.samples.push(ms);
      this.welford.push(ms);
      if (ms < this.minMs) this.minMs = ms;
      if (ms > this.maxMs) this.maxMs = ms;
    }
    if (row?.ok) this.ok += 1;
    else this.fail += 1;
    const st = row?.status ?? 0;
    this.statusCounts[st] = (this.statusCounts[st] || 0) + 1;
    this.bytesIn += row?.bytes || 0;
    this.sliding?.push(!!row?.ok);
  }

  _sampleView(): number[] {
    return this._reservoir ? this._reservoir.samples : this.samples;
  }

  get elapsedMs(): number {
    return Math.max(1, (this.endMs || Date.now()) - this.startMs);
  }

  get total(): number {
    return this.ok + this.fail;
  }

  get rps(): number {
    return (this.total / this.elapsedMs) * 1000;
  }

  get errorRate(): number {
    return this.total === 0 ? 0 : this.fail / this.total;
  }

  get slidingErrorRate(): number {
    return this.sliding ? this.sliding.errorRate : this.errorRate;
  }

  percentile(p: number): number {
    const view = this._sampleView();
    if (!view.length) return 0;
    const sorted = [...view].sort((a, b) => a - b);
    return percentileR7(sorted, p);
  }

  summary(): LatencySummary {
    const view = this._sampleView();
    const sorted = view.length ? [...view].sort((a, b) => a - b) : [];
    const w = this.welford.snapshot();
    return {
      total: this.total,
      ok: this.ok,
      fail: this.fail,
      errorRate: Number(this.errorRate.toFixed(6)),
      slidingErrorRate: Number(this.slidingErrorRate.toFixed(6)),
      elapsedMs: this.elapsedMs,
      rps: Number(this.rps.toFixed(2)),
      sampleCount: view.length,
      observedCount: this._reservoir ? this._reservoir.seen : view.length,
      reservoir: Boolean(this._reservoir),
      latencyMs: {
        min: Number.isFinite(this.minMs) ? this.minMs : 0,
        avg: Number(w.mean.toFixed(3)),
        stddev: Number(w.stddev.toFixed(3)),
        p50: Number(percentileR7(sorted, 50).toFixed(3)),
        p90: Number(percentileR7(sorted, 90).toFixed(3)),
        p95: Number(percentileR7(sorted, 95).toFixed(3)),
        p99: Number(percentileR7(sorted, 99).toFixed(3)),
        max: Number.isFinite(this.maxMs) ? this.maxMs : 0,
      },
      statusCounts: { ...this.statusCounts },
      bytesIn: this.bytesIn,
    };
  }
}

export type SloThresholds = {
  maxP99Ms?: number;
  maxP95Ms?: number;
  maxErrorRate?: number;
  maxSlidingErrorRate?: number;
  minRps?: number;
  minSamples?: number;
};

/**
 * 对照 SLO 阈值，返回违规列表
 */
export function evaluateSlo(
  summary: LatencySummary,
  slo: SloThresholds = {},
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if (slo.minSamples != null && (summary.sampleCount ?? summary.total) < slo.minSamples) {
    violations.push(`samples ${summary.sampleCount ?? summary.total} < ${slo.minSamples}`);
  }
  if (slo.maxP99Ms != null && summary.latencyMs.p99 > slo.maxP99Ms) {
    violations.push(`p99 ${summary.latencyMs.p99}ms > ${slo.maxP99Ms}ms`);
  }
  if (slo.maxP95Ms != null && summary.latencyMs.p95 > slo.maxP95Ms) {
    violations.push(`p95 ${summary.latencyMs.p95}ms > ${slo.maxP95Ms}ms`);
  }
  if (slo.maxErrorRate != null && summary.errorRate > slo.maxErrorRate) {
    violations.push(`errorRate ${summary.errorRate} > ${slo.maxErrorRate}`);
  }
  if (
    slo.maxSlidingErrorRate != null &&
    (summary.slidingErrorRate ?? summary.errorRate) > slo.maxSlidingErrorRate
  ) {
    violations.push(
      `slidingErrorRate ${summary.slidingErrorRate ?? summary.errorRate} > ${slo.maxSlidingErrorRate}`,
    );
  }
  if (slo.minRps != null && summary.rps < slo.minRps) {
    violations.push(`rps ${summary.rps} < ${slo.minRps}`);
  }
  return { ok: violations.length === 0, violations };
}
