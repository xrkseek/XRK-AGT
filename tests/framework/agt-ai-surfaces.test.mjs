/**
 * Surface contracts: web console /v1, ai.js harness gate, chat → callAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldUseHarnessModuleLoop } from '../../dist/src/utils/http/ai-v3-utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('AGT AI surface harness wiring', () => {
  it('package.json depends on publishable @xrkseek/harness only', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = pkg.dependencies || {};
    assert.ok(deps['@xrkseek/harness'], 'missing @xrkseek/harness');
    assert.match(String(deps['@xrkseek/harness']), /^\d+\.\d+\.\d+/);
    for (const key of Object.keys(deps)) {
      if (key.startsWith('@xrkseek/') && key !== '@xrkseek/harness') {
        assert.fail(`unexpected leaf dep ${key} — use SDK façade only`);
      }
      if (key.startsWith('@xrkseek/')) {
        assert.doesNotMatch(String(deps[key]), /^link:/, key);
      }
    }
  });

  it('pnpm-lock importers do not link harness leaf packages', () => {
    const lockPath = path.join(root, 'pnpm-lock.yaml');
    if (!fs.existsSync(lockPath)) return;
    const lock = fs.readFileSync(lockPath, 'utf8');
    // Root importer block ends at first top-level packages: or next non-indented section
    const importerMatch = lock.match(/^importers:\r?\n([\s\S]*?)^packages:\r?\n/m);
    const block = importerMatch ? importerMatch[1] : lock.slice(0, 4000);
    assert.doesNotMatch(block, /'@xrkseek\/core-/);
    assert.doesNotMatch(block, /'@xrkseek\/llm-/);
    assert.doesNotMatch(block, /'@xrkseek\/protocol'/);
    assert.match(block, /'@xrkseek\/harness'/);
    assert.doesNotMatch(block, /'@xrkseek\/harness':\r?\n\s+specifier: link:/);
  });

  it('shouldUseHarnessModuleLoop: web console (no tools) and MCP workflows', () => {
    assert.equal(shouldUseHarnessModuleLoop({ messages: [] }, null), true);
    assert.equal(shouldUseHarnessModuleLoop({}, []), true);
    assert.equal(shouldUseHarnessModuleLoop({}, ['chat']), true);
    assert.equal(
      shouldUseHarnessModuleLoop({ tools: [{ type: 'function', function: { name: 'x' } }] }, null),
      false,
    );
    assert.equal(
      shouldUseHarnessModuleLoop({ tools: [{ type: 'function', function: { name: 'x' } }] }, ['chat']),
      true,
    );
  });

  it('ai.ts imports harness loop + shouldUseHarnessModuleLoop', () => {
    const src = fs.readFileSync(path.join(root, 'core/system-Core/http/ai.ts'), 'utf8');
    assert.match(src, /runHarnessModuleLoop/);
    assert.match(src, /shouldUseHarnessModuleLoop/);
    assert.match(src, /trimMessagesToTokenBudget/);
  });

  it('chat workflow execute uses callAI (harness via AiWorkflow)', () => {
    const src = fs.readFileSync(path.join(root, 'core/system-Core/workflow/chat.ts'), 'utf8');
    assert.match(src, /await this\.callAI\(/);
    const aw = fs.readFileSync(
      path.join(root, 'src/infrastructure/ai-workflow/ai-workflow.ts'),
      'utf8',
    );
    assert.match(aw, /runHarnessModuleLoop/);
  });

  it('web ChatView posts /v1/chat/completions with optional workflows', () => {
    const src = fs.readFileSync(
      path.join(root, 'core/system-Core/www/xrk/src/views/ChatView.vue'),
      'utf8',
    );
    assert.match(src, /\/v1\/chat\/completions/);
    assert.match(src, /requestBody\.workflow\s*=\s*\{\s*workflows\s*\}/);
  });

  it('runHarnessModuleLoop works for web-like no-workflow turn', async () => {
    const { importHarnessSdk } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { runHarnessModuleLoop } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    let harness;
    try {
      harness = await importHarnessSdk();
    } catch {
      return;
    }
    globalThis.logger = globalThis.logger || {
      mark: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
    const out = await runHarnessModuleLoop({
      stream: { name: 'http-v3', _getToolWorkflowNames: () => [] },
      messages: [
        { role: 'system', content: 'console' },
        { role: 'user', content: 'ping' },
      ],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'web-ok', toolCalls: [] }]),
      },
      apiConfig: { workflows: [] },
    });
    assert.equal(out.content, 'web-ok');
  });
});
