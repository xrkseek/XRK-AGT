/**
 * 契约：工厂单次补全不执行工具；prepareOutbound 仅 trim；下列路径不得存在。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trimMessagesToTokenBudget } from '../../dist/src/utils/llm/message-token-budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('AGT loop cleanup contracts', () => {
  it('slimMessagesForExistingSession keeps system + latest user only', async () => {
    const { slimMessagesForExistingSession } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const slim = slimMessagesForExistingSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]);
    assert.deepEqual(slim, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u2' },
    ]);
  });

  it('resolveMaxSteps is 1 when no tools', async () => {
    const { __resolveMaxStepsForTests } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    assert.equal(__resolveMaxStepsForTests({ maxToolRounds: 7 }, {}, 0), 1);
    assert.equal(__resolveMaxStepsForTests({ maxToolRounds: 7 }, {}, 3), 7);
    assert.equal(__resolveMaxStepsForTests({}, { maxToolRounds: 4 }, 2), 4);
  });

  it('orphan tool-loop / compaction modules are gone', () => {
    const gone = [
      'src/utils/llm/tool-partition-utils.js',
      'src/utils/llm/tool-loop-finalize.js',
      'src/utils/llm/llm-retry.js',
      'src/utils/llm/llm-nonstream-reply.js',
      'src/utils/llm/strip-reasoning.js',
      'src/utils/llm/context-compaction.js',
      'src/utils/llm/tool-pair-compact.js',
      'src/utils/llm/compaction-prompt.js',
      'src/utils/llm/compaction-backup.js',
      'src/utils/llm/compaction-session-cache.js',
      'src/utils/llm/structured-summary.js',
    ];
    for (const rel of gone) {
      assert.equal(fs.existsSync(path.join(root, rel)), false, rel);
    }
    assert.equal(fs.existsSync(path.join(root, 'data/harness-bridge')), false);
  });

  it('trimMessagesToTokenBudget keeps recent messages under budget', () => {
    const messages = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
      { role: 'user', content: 'tail' },
    ];
    const estimate = (t) => String(t || '').length;
    const trimmed = trimMessagesToTokenBudget(messages, 500, estimate);
    assert.ok(trimmed.length < messages.length);
    assert.equal(trimmed[trimmed.length - 1]?.content, 'tail');
  });

  it('OpenAICompatible chat returns tool_calls without executing', async () => {
    const { default: OpenAICompatibleLLMClient } = await import(
      '../../dist/src/factory/llm/OpenAICompatibleLLMClient.js'
    );
    globalThis.logger = globalThis.logger || {
      mark: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
    const client = new OpenAICompatibleLLMClient({ model: 'm', baseUrl: 'http://127.0.0.1:9' });
    client._prepareMessages = async (m) => m;
    client._fetchRound = async () => ({
      json: async () => ({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tools.read', arguments: '{}' } }],
          },
        }],
      }),
    });
    const out = await client.chat([{ role: 'user', content: 'hi' }], {});
    assert.equal(out.content, '');
    assert.equal(out.toolCalls.length, 1);
  });

  it('resolveHarnessCompaction maps contextWindow to soft budget', async () => {
    const { resolveHarnessCompaction } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const c = resolveHarnessCompaction({ contextWindow: 128000, maxTokens: 4096 });
    assert.ok(c);
    assert.equal(c.auto, true);
    assert.ok(c.maxRequestTokens >= 800);
    assert.ok(c.keepTokens >= 2000);
  });

  it('foldUsageFromEvents sums assistant usage', async () => {
    const { foldUsageFromEvents } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const u = foldUsageFromEvents([
      { type: 'assistant/message', usage: { inputTokens: 10, outputTokens: 3 } },
      { type: 'assistant/message', usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    assert.deepEqual(u, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
  });

  it('createLlmFromConfig prefers DeepSeek adapter when available', async () => {
    const { createLlmFromConfig } = await import(
      '../../dist/src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    let used = '';
    let thinking;
    const fake = {
      createDeepSeekAdapter: (opts) => {
        used = 'deepseek';
        thinking = opts.deepseekThinking;
        return { id: opts.id, chat: async () => ({}) };
      },
      createOpenAiCompatibleAdapter: (opts) => {
        used = 'compat';
        return { id: opts.id, chat: async () => ({}) };
      },
    };
    const llm = createLlmFromConfig(fake, {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      thinkingType: 'enabled',
    });
    assert.equal(used, 'deepseek');
    assert.equal(thinking?.thinking, 'enabled');
    assert.equal(thinking?.reasoningEffort, 'high');
    assert.equal(llm.peekRoute()?.reasoningEffort, 'high');
  });

  it('AiWorkflow.prepareOutboundMessages only trims', async () => {
    const { default: AiWorkflow } = await import(
      '../../dist/src/infrastructure/ai-workflow/ai-workflow.js'
    );
    globalThis.logger = globalThis.logger || {
      mark: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    };
    const stream = Object.create(AiWorkflow.prototype);
    stream.name = 'contract-test';
    stream.estimateTokens = (t) => String(t || '').length;
    const messages = [
      { role: 'user', content: 'x'.repeat(3000) },
      { role: 'assistant', content: 'y'.repeat(3000) },
      { role: 'user', content: 'keep-me' },
    ];
    const outbound = await stream.prepareOutboundMessages(messages, {
      contextWindow: 8000,
      maxTokens: 100,
    });
    assert.ok(Array.isArray(outbound));
    assert.equal(outbound[outbound.length - 1]?.content, 'keep-me');
    assert.ok(outbound.length < messages.length);
  });
});
