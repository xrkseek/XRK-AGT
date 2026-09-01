/**
 * Unit tests for harness module loop helpers + SDK smoke.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitOutboundMessages,
  seedSessionFromHistory,
  extractAssistantToolCalls,
  isLikelyReadOnlyTool,
  mapHarnessReasoningEffort,
  resolveToolSettle,
  resolveHarnessSafety,
  resolveDenyToolNames,
  resolveHarnessLlmRetry,
  withRouteReasoning,
} from '../../src/infrastructure/ai-workflow/harness-module-loop.js';

describe('harness-module-loop helpers', () => {
  it('splitOutboundMessages extracts system, history, latest user', () => {
    const { system, history, userText } = splitOutboundMessages([
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'next' },
    ]);
    assert.equal(system, 'persona');
    assert.equal(userText, 'next');
    assert.equal(history.length, 2);
    assert.equal(history[0].content, 'hi');
    assert.equal(history[1].content, 'hello');
  });

  it('splitOutboundMessages keeps prior tool turns in history', () => {
    const { history, userText } = splitOutboundMessages([
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a.read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'a.read', content: '{"ok":true}' },
      { role: 'user', content: 'again' },
    ]);
    assert.equal(userText, 'again');
    assert.equal(history.length, 3);
    assert.equal(history[1].tool_calls[0].id, 'c1');
    assert.equal(history[2].role, 'tool');
  });

  it('extractAssistantToolCalls + seedSessionFromHistory write tool events', () => {
    const calls = extractAssistantToolCalls({
      tool_calls: [{ id: 'c1', function: { name: 'a.read', arguments: '{"q":1}' } }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].arguments.q, 1);

    const events = [];
    const store = {
      append(_id, ev) { events.push(ev); },
    };
    seedSessionFromHistory(store, 's1', [
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'a.read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'a.read', content: 'ok' },
    ]);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['user/message', 'assistant/message', 'tool/call', 'tool/result']);
    assert.equal(events[1].toolCalls[0].id, 'c1');
    assert.equal(events[3].result.toolCallId, 'c1');
  });

  it('isLikelyReadOnlyTool / mapHarnessReasoningEffort / resolveToolSettle', () => {
    assert.equal(isLikelyReadOnlyTool('fs.read'), true);
    assert.equal(isLikelyReadOnlyTool('chat.reply'), false);
    assert.equal(mapHarnessReasoningEffort('medium'), 'high');
    assert.equal(mapHarnessReasoningEffort('off'), 'off');
    assert.deepEqual(resolveToolSettle({ parallel_tool_calls: false }), { toolSettle: 'serial' });
    assert.deepEqual(
      resolveToolSettle({ maxParallelToolCalls: 2 }),
      { toolSettle: 'parallel', maxParallelToolCalls: 2 },
    );
  });

  it('resolveHarnessSafety / resolveDenyToolNames', () => {
    assert.equal(resolveHarnessSafety({}, {}), undefined);
    assert.equal(resolveHarnessSafety({ safety: false }, {}), false);
    assert.deepEqual(
      resolveHarnessSafety({}, { harnessSafety: { mistake: { maxConsecutiveMistakes: 3 } } }),
      { mistake: { maxConsecutiveMistakes: 3 } },
    );
    assert.equal(resolveDenyToolNames({}, {}), undefined);
    assert.deepEqual(resolveDenyToolNames({ denyTools: ['a.b', ''] }, {}), ['a.b']);
  });

  it('resolveHarnessLlmRetry maps AGT retry to SDK policy', () => {
    assert.equal(resolveHarnessLlmRetry({ retry: { enabled: false } }, {}), false);
    assert.equal(resolveHarnessLlmRetry({}, { retry: false }), false);
    assert.deepEqual(
      resolveHarnessLlmRetry({
        retry: {
          enabled: true,
          maxAttempts: 3,
          delay: 2000,
          retryOn: ['timeout', 'rate_limit', 'empty'],
        },
      }, {}),
      {
        maxRetries: 2,
        initialDelayMs: 2000,
        retryableCodes: ['TIMEOUT', 'RATE_LIMIT', 'EMPTY_RESPONSE'],
      },
    );
    assert.deepEqual(
      resolveHarnessLlmRetry({ retry: { maxRetries: 4 } }, {}),
      { maxRetries: 4 },
    );
  });

  it('buildHarnessUserTurn maps data-URL image via SDK attachment store', async () => {
    const { importHarnessSdk } = await import(
      '../../src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { buildHarnessUserTurn } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    let harness;
    try {
      harness = await importHarnessSdk();
    } catch {
      return;
    }
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const turn = await buildHarnessUserTurn(harness, [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ]);
    assert.equal(turn.hasImage, true);
    assert.equal(turn.text, 'see');
    assert.ok(Array.isArray(turn.userContent));
    assert.equal(turn.userContent.some((b) => b.type === 'image'), true);
    const img = turn.userContent.find((b) => b.type === 'image');
    const stored = await turn.resolveImage(img.attachment.attachmentId);
    assert.equal(stored.mediaType, 'image/png');
    assert.ok(stored.data?.byteLength > 0);
  });

  it('withRouteReasoning exposes peekRoute effort', () => {
    const llm = withRouteReasoning({ id: 'x', chat: async () => ({}) }, 'high', 'm');
    assert.equal(llm.peekRoute().reasoningEffort, 'high');
    assert.equal(llm.ensureRoute().reasoningEffort, 'high');
  });
});

describe('harness SDK continueTurn smoke', () => {
  it('runs createAgent with replay when SDK resolvable', async () => {
    let harness;
    try {
      const { importHarnessSdk } = await import(
        '../../src/infrastructure/ai-workflow/harness-resolve.js'
      );
      harness = await importHarnessSdk();
    } catch (err) {
      assert.ok(/harness|Cannot find|不可用/i.test(String(err.message)), err.message);
      return;
    }

    const store = harness.createMemorySessionStore();
    const session = store.create('agt-smoke');
    const tools = harness.createToolRegistry();
    const agent = harness.createAgent({
      sessionId: session.id,
      store,
      llm: harness.createReplayAdapter([{ content: 'pong', toolCalls: [] }]),
      tools,
      safety: false,
      system: 'test',
    });
    const result = await agent.continueTurn({ text: 'ping' });
    assert.equal(result.text, 'pong');
  });

  it('runHarnessModuleLoop embeds loop under callAI shape', async () => {
    const { importHarnessSdk } = await import(
      '../../src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { runHarnessModuleLoop } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
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
      stream: { name: 'chat', _getToolWorkflowNames: () => [] },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'ping' },
      ],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'loop-ok', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: { workflows: [] },
    });
    assert.equal(out.content, 'loop-ok');
    assert.deepEqual(out.executedToolNames, []);
    assert.ok(out.sessionId);
    assert.equal(typeof out.steps, 'number');
  });

  it('registerTools hook adds tools before continueTurn', async () => {
    const { importHarnessSdk } = await import(
      '../../src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { runHarnessModuleLoop } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
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
    let registered = false;
    const out = await runHarnessModuleLoop({
      stream: { name: 'chat', _getToolWorkflowNames: () => [] },
      messages: [{ role: 'user', content: 'ping' }],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'hook-ok', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: {
        workflows: [],
        registerTools(registry) {
          registry.register({
            name: 'hook.ping',
            description: 'test',
            parameters: { type: 'object', properties: {} },
            async execute() { return { content: 'ok' }; },
          });
          registered = true;
          return 1;
        },
      },
    });
    assert.equal(registered, true);
    assert.equal(out.content, 'hook-ok');
  });

  it('foldMcpToolsFromEvents keeps last-turn args + result', async () => {
    const { foldMcpToolsFromEvents } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const tools = foldMcpToolsFromEvents([
      { type: 'turn/start', turnId: 't1' },
      { type: 'tool/call', turnId: 't1', call: { id: 'c1', name: 'old.read', arguments: { path: 'a' } } },
      { type: 'tool/result', turnId: 't1', result: { toolCallId: 'c1', name: 'old.read', content: 'old' } },
      { type: 'turn/start', turnId: 't2' },
      { type: 'tool/call', turnId: 't2', call: { id: 'c2', name: 'web.web_search', arguments: { q: '国足' } } },
      { type: 'tool/result', turnId: 't2', result: { toolCallId: 'c2', name: 'web.web_search', content: { hits: 1 } } },
    ]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].id, 'c2');
    assert.equal(tools[0].name, 'web.web_search');
    assert.deepEqual(tools[0].arguments, { q: '国足' });
    assert.deepEqual(tools[0].result, { hits: 1 });
  });

  it('reuses harness session for same sessionKey', async () => {
    const { importHarnessSdk } = await import(
      '../../src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { runHarnessModuleLoop } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const { resetHarnessSessionRegistryForTests } = await import(
      '../../src/infrastructure/ai-workflow/harness-session-registry.js'
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
    resetHarnessSessionRegistryForTests();
    const sessionKey = `fw-reuse-${Date.now().toString(36)}`;
    const first = await runHarnessModuleLoop({
      stream: { name: 'chat', _getToolWorkflowNames: () => [] },
      messages: [{ role: 'user', content: 'ping-1' }],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'one', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: { workflows: [], sessionKey },
    });
    assert.equal(first.reused, false);
    assert.equal(first.content, 'one');

    const second = await runHarnessModuleLoop({
      stream: { name: 'chat', _getToolWorkflowNames: () => [] },
      messages: [
        { role: 'user', content: 'ping-1' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'ping-2' },
      ],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'two', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: { workflows: [], sessionKey },
    });
    assert.equal(second.reused, true);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.content, 'two');
    resetHarnessSessionRegistryForTests();
  });

  it('onSessionEvent observes assistant message appends', async () => {
    const { importHarnessSdk } = await import(
      '../../src/infrastructure/ai-workflow/harness-resolve.js'
    );
    const { runHarnessModuleLoop } = await import(
      '../../src/infrastructure/ai-workflow/harness-module-loop.js'
    );
    const { resetHarnessSessionRegistryForTests } = await import(
      '../../src/infrastructure/ai-workflow/harness-session-registry.js'
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
    resetHarnessSessionRegistryForTests();
    const types = [];
    const out = await runHarnessModuleLoop({
      stream: { name: 'chat', _getToolWorkflowNames: () => [] },
      messages: [{ role: 'user', content: 'ping' }],
      config: {
        _harnessLlm: harness.createReplayAdapter([{ content: 'live-ok', toolCalls: [] }]),
        safety: false,
      },
      apiConfig: {
        workflows: [],
        sessionKey: `fw-live-${Date.now().toString(36)}`,
        onSessionEvent(ev) {
          if (ev?.type) types.push(ev.type);
        },
      },
    });
    assert.equal(out.content, 'live-ok');
    assert.ok(types.includes('user/message'));
    assert.ok(types.includes('assistant/message') || types.includes('assistant/chunk'));
    resetHarnessSessionRegistryForTests();
  });
});
