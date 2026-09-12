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

  it('key harness/ai framework tests no longer hardcode ../../dist/src ai-workflow paths', () => {
    const files = [
      'tests/framework/harness-module-loop.test.mjs',
      'tests/framework/agt-loop-cleanup.test.mjs',
      'tests/framework/agt-ai-surfaces.test.mjs',
      'tests/framework/sse-openai-live-bridge.test.mjs',
      'tests/framework/callai-harness-e2e.test.mjs',
      'tests/framework/v1-path-split-e2e.test.mjs',
      'tests/framework/v1-live-sse-e2e.test.mjs',
      'tests/framework/mcp-workflows-harness-e2e.test.mjs',
    ];
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
