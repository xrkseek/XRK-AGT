/**
 * harness/ai 测入口契约：helpers/harness-ai.mjs + # package imports（仍 .mjs）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARNESS_AI_SPECIFIERS,
  importHarnessAi,
  splitOutboundMessages,
  shouldUseHarnessModuleLoop,
  createHarnessLiveSessionEventHandler,
} from '../helpers/harness-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperPath = path.join(root, 'tests/helpers/harness-ai.mjs');

describe('harness-ai test import contract', () => {
  it('helper uses #infrastructure/#utils only (no ../../dist)', () => {
    const src = fs.readFileSync(helperPath, 'utf8');
    assert.match(src, /#infrastructure\/ai-workflow\/harness-module-loop\.js/);
    assert.match(src, /#utils\/sse-openai\.js/);
    assert.doesNotMatch(src, /\.\.\/\.\.\/dist\/src\//);
    assert.equal(HARNESS_AI_SPECIFIERS.loop, '#infrastructure/ai-workflow/harness-module-loop.js');
    assert.equal(HARNESS_AI_SPECIFIERS.sseOpenai, '#utils/sse-openai.js');
  });

  it('re-exports resolve and type surface modules load via importHarnessAi', async () => {
    assert.equal(typeof splitOutboundMessages, 'function');
    assert.equal(typeof shouldUseHarnessModuleLoop, 'function');
    assert.equal(typeof createHarnessLiveSessionEventHandler, 'function');
    const loop = await importHarnessAi('loop');
    assert.equal(typeof loop.runHarnessModuleLoop, 'function');
    const sse = await importHarnessAi('sseOpenai');
    assert.equal(typeof sse.createHarnessLiveSessionEventHandler, 'function');
    // d.ts 类型入口存在（tsc 产物）
    assert.ok(
      fs.existsSync(path.join(root, 'dist/src/infrastructure/ai-workflow/harness-module-loop.d.ts'))
        || fs.existsSync(path.join(root, 'dist/src/infrastructure/ai-workflow/harness-module-loop.js')),
    );
  });

  const HARNESS_LINT_RE = /(harness|agt-ai|agt-loop|^ai|loop|sse|callai|v1-(path-split|live-sse))/i;

  it('key harness/ai framework tests no longer hardcode ../../dist/src ai-workflow paths', () => {
    // 目录扫描而非死清单：unit/integration 下 harness/ai/loop/sse 相关测试
    // （与 run.mjs「目录即事实源」一致，新增/搬迁自动生效）
    const files = ['unit', 'integration'].flatMap((lane) =>
      fs
        .readdirSync(path.join(root, 'tests', lane))
        .filter((f) => f.endsWith('.test.mjs') && HARNESS_LINT_RE.test(f))
        .map((f) => path.join('tests', lane, f)),
    );
    assert.ok(files.length >= 8, `应至少扫到 8 个测试，实际 ${files.length}`);
    for (const rel of files) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(
        text,
        /\.\.\/\.\.\/dist\/src\/infrastructure\/ai-workflow\//,
        rel,
      );
      assert.doesNotMatch(text, /\.\.\/\.\.\/dist\/src\/utils\/sse-openai\.js/, rel);
    }
  });
});
