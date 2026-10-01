/**
 * any-heat 基线契约：脚本可跑、基线已入库、验收阈值齐全。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = path.join(root, 'tests/baselines/any-heat-baseline.json');
const scriptPath = path.join(root, 'scripts/any-heat.mjs');

describe('any-heat baseline', () => {
  it('baseline file exists with topN + reduceTarget', () => {
    assert.equal(fs.existsSync(baselinePath), true);
    const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    assert.equal(b.root, 'src');
    assert.equal(b.topN, 15);
    assert.equal(b.reduceTarget, 0.5);
    assert.ok(Number.isFinite(b.totalAny) && b.totalAny > 0);
    assert.ok(Array.isArray(b.files) && b.files.length >= b.topN);
    assert.equal(b.files[0].path, 'src/agent-runtime.ts');
  });

  it('scripts/any-heat.mjs runs (exit 0)', () => {
    const r = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /\[any-heat\]/);
    assert.match(r.stdout, /totalAny=/);
  });
});
