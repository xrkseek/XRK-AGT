/**
 * /v1 stream=true live SSE（chunk/tool）与 Anthropic/Responses 整段 JSON 分支。
 * @see docs/harness-module-loop.md · src/utils/sse-openai.ts · core/system-Core/http/ai.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldWantOpenAiLiveSse,
  createOpenAiWorkflowDeltaHandler,
  createHarnessLiveSessionEventHandler,
  createOpenAIChunk,
} from '../helpers/harness-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AI_TS = path.join(root, 'core/system-Core/http/ai.ts');

function mockRes() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
    },
    end() {
      chunks.push('__END__');
    },
    setHeader() {},
    flushHeaders() {},
    flush() {},
  };
}

function parseSsePayloads(res) {
  return res.chunks
    .filter((line) => String(line).startsWith('data: '))
    .map((line) => {
      const raw = String(line).replace(/^data: /, '').replace(/\n\n$/, '');
      if (raw === '[DONE]') return { done: true };
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('/v1 live SSE vs Anthropic/Responses 整段 JSON', () => {
  it('shouldWantOpenAiLiveSse：仅 OpenAI Chat stream；anthropic/responses 为 false', () => {
    assert.equal(shouldWantOpenAiLiveSse(true, undefined), true);
    assert.equal(shouldWantOpenAiLiveSse(true, null), true);
    assert.equal(shouldWantOpenAiLiveSse(true, 'openai'), true);
    assert.equal(shouldWantOpenAiLiveSse(false, undefined), false);
    assert.equal(shouldWantOpenAiLiveSse(true, 'anthropic'), false);
    assert.equal(shouldWantOpenAiLiveSse(true, 'responses'), false);
    assert.equal(shouldWantOpenAiLiveSse(false, 'anthropic'), false);
  });

  it('ai.ts：wantLiveSse 用 shouldWantOpenAiLiveSse；anthropic/responses 走 HttpResponse.json', () => {
    const src = fs.readFileSync(AI_TS, 'utf8');
    assert.match(src, /shouldWantOpenAiLiveSse\s*\(\s*streamFlag,\s*req\.xrkGatewayFormat\s*\)/);
    assert.match(src, /createHarnessLiveSessionEventHandler/);
    assert.match(
      src,
      /Anthropic\/Responses[^\n]*整段 JSON|即使[^\n]*stream[^\n]*整段 JSON/,
    );
    assert.match(src, /HttpResponse\.json\s*\(\s*res,\s*openAIChatToAnthropicMessage/);
    assert.match(src, /HttpResponse\.json\s*\(\s*res,\s*openAIChatToResponsesObject/);
    // 收尾条件：非 stream 或网关 anthropic/responses → JSON（非 OpenAI SSE 收尾）
    assert.match(
      src,
      /!streamFlag\s*\|\|\s*req\.xrkGatewayFormat\s*===\s*'anthropic'\s*\|\|\s*req\.xrkGatewayFormat\s*===\s*'responses'/,
    );
  });

  it('行为：stream live 路径写出 chunk + tool mcp_tools + finish 形态', () => {
    assert.equal(shouldWantOpenAiLiveSse(true, null), true);

    const res = mockRes();
    const liveHandler = createOpenAiWorkflowDeltaHandler(res, {
      id: 'chatcmpl_live',
      created: 42,
      model: 'm',
    });
    const bridge = createHarnessLiveSessionEventHandler(liveHandler);

    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'text', text: 'Hello' });
    bridge.onSessionEvent({
      type: 'tool/call',
      call: { id: 'c1', name: 'fs.read', arguments: { path: '/a' } },
    });
    bridge.onSessionEvent({
      type: 'tool/result',
      result: { toolCallId: 'c1', name: 'fs.read', content: { ok: true } },
    });
    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'text', text: ' world' });

    // 对齐 ai.ts OpenAI stream 收尾：finish chunk + [DONE]
    const stats = liveHandler.getStats();
    writeFinish(res, {
      id: 'chatcmpl_live',
      created: 42,
      model: 'm',
      finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    res.write('data: [DONE]\n\n');

    const payloads = parseSsePayloads(res);
    const textChunks = payloads.filter((p) => p.choices?.[0]?.delta?.content);
    assert.deepEqual(
      textChunks.map((p) => p.choices[0].delta.content),
      ['Hello', ' world'],
    );
    const toolChunk = payloads.find((p) => Array.isArray(p.mcp_tools));
    assert.ok(toolChunk);
    assert.deepEqual(toolChunk.mcp_tools, [{
      id: 'c1',
      name: 'fs.read',
      arguments: { path: '/a' },
      result: { ok: true },
    }]);
    const finish = payloads.find((p) => p.choices?.[0]?.finish_reason === 'stop');
    assert.ok(finish);
    assert.ok(payloads.some((p) => p.done === true));
    assert.equal(stats.totalContent, 'Hello world');
  });

  it('行为：anthropic/responses 门禁关闭 live SSE（不挂 onSessionEvent 桥）', () => {
    assert.equal(shouldWantOpenAiLiveSse(true, 'anthropic'), false);
    assert.equal(shouldWantOpenAiLiveSse(true, 'responses'), false);
    // 无 live bridge 时 createHarnessLiveSessionEventHandler(null) 吞事件
    const bridge = createHarnessLiveSessionEventHandler(null);
    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'text', text: 'nope' });
    assert.equal(bridge._pendingSize(), 0);
  });
});

function writeFinish(res, { id, created, model, finishReason, usage }) {
  const chunk = createOpenAIChunk({
    id,
    created,
    model,
    delta: {},
    finishReason,
    usage,
  });
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}
