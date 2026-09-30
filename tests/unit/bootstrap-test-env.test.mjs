/**
 * tests/helpers/bootstrap.mjs：dist 路径 + PluginBase/msgSegment + XRK_TEST=1
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapTestEnv } from '../helpers/bootstrap.mjs';
import { getRuntimeGlobal } from '#utils/runtime-globals.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperSrc = fs.readFileSync(path.join(root, 'tests/helpers/bootstrap.mjs'), 'utf8');

describe('bootstrapTestEnv (dist + globals)', () => {
  it('helper 源码对齐 dist/bootstrap-globals，不写 src/bootstrap-globals', () => {
    assert.match(helperSrc, /dist[/\\]src[/\\]bootstrap-globals\.js|dist\/src\/bootstrap-globals\.js/);
    assert.match(helperSrc, /XRK_TEST\s*=\s*['"]1['"]/);
    assert.match(helperSrc, /PluginBase/);
    assert.match(helperSrc, /msgSegment/);
    assert.doesNotMatch(helperSrc, /import\(['"]\.\.\/\.\.\/src\/bootstrap-globals/);
    assert.ok(fs.existsSync(path.join(root, 'dist/src/bootstrap-globals.js')));
  });

  it('bootstrapTestEnv mounts PluginBase / msgSegment and sets XRK_TEST', async () => {
    await bootstrapTestEnv();
    assert.equal(process.env.XRK_TEST, '1');
    assert.equal(typeof getRuntimeGlobal('PluginBase'), 'function');
    const seg = getRuntimeGlobal('msgSegment');
    assert.equal(typeof seg, 'object');
    assert.equal(typeof seg.image, 'function');
    assert.equal(typeof getRuntimeGlobal('AgentRuntime')?.on, 'function');
  });
});
