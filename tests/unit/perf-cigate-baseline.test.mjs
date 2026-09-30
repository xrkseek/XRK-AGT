/**
 * cigate 性能门禁基线契约（不重跑压测；压测见 pnpm test:perf:gate）
 * @see tests/perf/README.md · tests/baselines/perf-cigate-baseline.json
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES } from '../perf/profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = path.join(root, 'tests/baselines/perf-cigate-baseline.json');

describe('perf cigate baseline', () => {
  it('baseline 入库且与 cigate SLO 对齐', () => {
    assert.equal(fs.existsSync(baselinePath), true);
    const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.equal(b.profile, 'cigate');
    assert.equal(b.command, 'pnpm test:perf:gate');
    assert.equal(b.dist, true);
    assert.equal(b.target, 'health');

    const cigate = PROFILES.cigate;
    assert.ok(cigate);
    assert.equal(b.slo.maxP99Ms, cigate.slo.maxP99Ms);
    assert.equal(b.slo.maxErrorRate, cigate.slo.maxErrorRate);
    assert.equal(b.slo.minRps, cigate.slo.minRps);

    assert.ok(Number.isFinite(b.baseline.load.rps) && b.baseline.load.rps >= b.slo.minRps);
    assert.ok(b.baseline.load.p99Ms <= b.slo.maxP99Ms);
    assert.ok(b.baseline.soak.p99Ms <= b.slo.maxP99Ms);
    assert.equal(b.baseline.load.errorRate, 0);
    assert.ok(b.baseline.metricsHttp.total > 0);
  });
});
