/**
 * /v1 OpenAI live SSE: assistant/chunk + tool/call + tool/result → mcp_tools
 * Entry: tests/helpers/harness-ai.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAiWorkflowDeltaHandler,
  createHarnessLiveSessionEventHandler,
  createOpenAIChunk,
} from '../helpers/harness-ai.mjs';

function mockRes() {
  const chunks = [];
  return {
    chunks,
    write(s) {
      chunks.push(String(s));
    },
    setHeader() {},
    flushHeaders() {},
    flush() {},
  };
}

function parseSsePayloads(res) {
  return res.chunks
    .map((line) => {
      const m = String(line).match(/^data: (.+)\n\n$/s);
      if (!m) return null;
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe('createHarnessLiveSessionEventHandler → SSE/mcp_tools', () => {
  it('maps assistant/chunk text and reasoning to delta handler', () => {
    const calls = [];
    const bridge = createHarnessLiveSessionEventHandler({
      callback(delta, meta) {
        calls.push({ delta, meta });
      },
    });
    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'text', text: 'hi' });
    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'reasoning', text: 'think' });
    bridge.onSessionEvent({ type: 'assistant/chunk', kind: 'text', text: '' }); // no-op
    bridge.onSessionEvent(null);
    assert.deepEqual(calls, [
      { delta: 'hi', meta: undefined },
      { delta: '', meta: { reasoning_content: 'think' } },
    ]);
  });

  it('buffers tool/call args and emits mcp_tools on tool/result', () => {
    const calls = [];
    const bridge = createHarnessLiveSessionEventHandler({
      callback(delta, meta) {
        calls.push({ delta, meta });
      },
    });
    bridge.onSessionEvent({
      type: 'tool/call',
      call: { id: 'c1', name: 'fs.read', arguments: { path: '/a' } },
    });
    assert.equal(bridge._pendingSize(), 1);
    // tool/call alone must not emit SSE metadata
    assert.equal(calls.length, 0);

    bridge.onSessionEvent({
      type: 'tool/result',
      result: { toolCallId: 'c1', name: 'fs.read', content: { ok: true } },
    });
    assert.equal(bridge._pendingSize(), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].delta, '');
    assert.deepEqual(calls[0].meta.mcp_tools, [{
      id: 'c1',
      name: 'fs.read',
      arguments: { path: '/a' },
      result: { ok: true },
    }]);
  });

  it('marks isError on tool/result and tolerates missing pending args', () => {
    const calls = [];
    const bridge = createHarnessLiveSessionEventHandler({
      callback(_d, meta) {
        calls.push(meta);
      },
    });
    bridge.onSessionEvent({
      type: 'tool/result',
      result: {
        toolCallId: 'orphan',
        name: 'web.search',
        content: 'boom',
        isError: true,
      },
    });
    assert.deepEqual(calls[0].mcp_tools, [{
      id: 'orphan',
      name: 'web.search',
      arguments: {},
      result: 'boom',
      isError: true,
    }]);
  });

  it('createOpenAiWorkflowDeltaHandler writes mcp_tools onto SSE chunks', () => {
    const res = mockRes();
    const { callback, getStats } = createOpenAiWorkflowDeltaHandler(res, {
      id: 'chatcmpl_t',
      created: 1,
      model: 'm',
    });
    callback('Hello');
    callback('', {
      mcp_tools: [{
        id: 'c1',
        name: 'fs.read',
        arguments: { path: 'x' },
        result: 'ok',
      }],
    });
    const payloads = parseSsePayloads(res);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].choices[0].delta.content, 'Hello');
    assert.deepEqual(payloads[1].mcp_tools, [{
      id: 'c1',
      name: 'fs.read',
      arguments: { path: 'x' },
      result: 'ok',
    }]);
    assert.equal(getStats().totalContent, 'Hello');
    assert.equal(getStats().chunkCount, 1);
  });

  it('createOpenAIChunk places mcp_tools at top level', () => {
    const chunk = createOpenAIChunk({
      id: 'id',
      created: 1,
      model: 'm',
      mcpTools: [{ name: 'a.b', result: 1 }],
    });
    assert.deepEqual(chunk.mcp_tools, [{ name: 'a.b', result: 1 }]);
    assert.equal(chunk.choices, undefined);
  });
});
