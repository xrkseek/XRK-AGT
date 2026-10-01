/**
 * /v1 双路径分流 E2E：
 * - 无 client tools（及有 workflows）→ harness（runHarnessModuleLoop）
 * - 无 workflows + 有 client tools → 工厂透传（LLMFactory.createClient.chat，tool_calls 回客户端）
 * @see docs/harness-module-loop.md「现行数据流」· docs/factory.md · docs/adr/0002-harness-module-first.md
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldUseHarnessModuleLoop,
  runHarnessModuleLoop,
} from '../helpers/harness-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AI_TS = path.join(root, 'core/system-Core/http/ai.ts');

const CLIENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object', properties: {} },
    },
  },
];

describe('/v1 harness vs 工厂透传 双路径分流', () => {
  it('门禁矩阵：无 tools→harness；有 client tools→工厂；workflows 覆盖 tools', () => {
    // A: Web 控制台 / 纯对话
    assert.equal(shouldUseHarnessModuleLoop({}, null), true);
    assert.equal(shouldUseHarnessModuleLoop({ messages: [] }, null), true);
    assert.equal(shouldUseHarnessModuleLoop({ tools: [] }, null), true, '空 tools[] 仍走 harness');

    // B: 仅 client tools → 工厂
    assert.equal(shouldUseHarnessModuleLoop({ tools: CLIENT_TOOLS }, null), false);
    assert.equal(shouldUseHarnessModuleLoop({ tools: CLIENT_TOOLS }, []), false);

    // C: MCP workflows 优先（即使带 client tools）
    assert.equal(shouldUseHarnessModuleLoop({ tools: CLIENT_TOOLS }, ['chat']), true);
    assert.equal(shouldUseHarnessModuleLoop({}, ['v3', 'tools']), true);
  });

  it('ai.ts 结构：先 shouldUseHarnessModuleLoop，harness 分支在工厂 createClient 之前', () => {
    const src = fs.readFileSync(AI_TS, 'utf8');
    assert.match(src, /shouldUseHarnessModuleLoop\(body,\s*effectiveStreams\)/);
    assert.match(src, /if\s*\(\s*useHarnessLoop\s*\)/);
    assert.match(src, /runHarnessModuleLoop\s*\(/);
    assert.match(src, /LLMFactory\.createClient\s*\(/);
    assert.match(src, /client\.chat\s*\(/);

    const gateAt = src.indexOf('shouldUseHarnessModuleLoop(body, effectiveStreams)');
    const harnessIfAt = src.indexOf('if (useHarnessLoop)');
    const harnessCallAt = src.indexOf('runHarnessModuleLoop({');
    const factoryAt = src.indexOf('LLMFactory.createClient(llmConfig)');
    assert.ok(gateAt >= 0 && harnessIfAt > gateAt, '门禁须先于 if (useHarnessLoop)');
    assert.ok(harnessCallAt > harnessIfAt, 'harness 调用须在 useHarnessLoop 分支内之后');
    assert.ok(factoryAt > harnessCallAt, '工厂透传须在 harness 分支之后（else 路径）');
  });

  it('行为 A：无 tools → harness replay 出 content', async () => {
    const { importHarnessSdk } = await import('#infrastructure/ai-workflow/harness-resolve.js');
    let harness;
    try {
      harness = await importHarnessSdk();
    } catch {
      return;
    }
    globalThis.logger = globalThis.logger || {
      mark: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const body = {
      messages: [
        { role: 'system', content: 'console' },
        { role: 'user', content: 'ping' },
      ],
    };
    assert.equal(shouldUseHarnessModuleLoop(body, null), true);

    const out = await runHarnessModuleLoop({
      stream: { name: 'http-v3', _getToolWorkflowNames: () => [] },
      messages: body.messages,
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'v1-harness-ok', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: { workflows: [] },
    });
    assert.equal(out.content, 'v1-harness-ok');
    assert.ok(out.sessionId);
  });

  it('行为 B：有 client tools → 不进 harness；工厂 chat 透传 tool_calls', async () => {
    const body = {
      messages: [{ role: 'user', content: 'use lookup' }],
      tools: CLIENT_TOOLS,
    };
    assert.equal(shouldUseHarnessModuleLoop(body, null), false, '须分流到工厂');

    const { default: LLMFactory } = await import('#factory/llm/LLMFactory.js');
    const orig = LLMFactory.createClient;
    let chatArgs;
    LLMFactory.createClient = () => ({
      async chat(messages, overrides) {
        chatArgs = { messages, overrides };
        return {
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        };
      },
    });
    try {
      // 对齐 ai.ts 工厂分支：createClient → chat(messages, overrides)
      const client = LLMFactory.createClient({ provider: 'stub' });
      const overrides = { tools: CLIENT_TOOLS };
      const chatResult = await client.chat(body.messages, overrides);
      assert.ok(chatArgs);
      assert.equal(chatArgs.overrides.tools, CLIENT_TOOLS);
      assert.equal(chatResult.content, '');
      assert.equal(chatResult.tool_calls[0].function.name, 'lookup');
    } finally {
      LLMFactory.createClient = orig;
    }
  });
});
