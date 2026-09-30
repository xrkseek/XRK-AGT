/**
 * E2E：MCP workflows 白名单 → harness ToolRegistry → MCPServer 执行回灌。
 * @see docs/harness-module-loop.md「MCP 执行边界」· docs/mcp-guide.md · docs/adr/0002-harness-module-first.md
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { MCPToolAdapter } from '#utils/llm/mcp-tool-adapter.js';
import { runHarnessModuleLoop } from '../helpers/harness-ai.mjs';

describe('MCP workflows 白名单 → harness registry 执行回灌', () => {
  /** @type {unknown} */
  let prevMcp;
  /** @type {string[]} */
  const handleLog = [];

  before(() => {
    prevMcp = AiWorkflowLoader.mcpServer;
    const tools = new Map([
      [
        'tools.echo',
        {
          name: 'tools.echo',
          description: 'echo args',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ],
      [
        'tools.ping',
        {
          name: 'tools.ping',
          description: 'ping',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      [
        'chat.reply',
        {
          name: 'chat.reply',
          description: 'out of tools.* whitelist',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      [
        'remote-mcp.weather.forecast',
        {
          name: 'remote-mcp.weather.forecast',
          description: 'other scope',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    ]);

    AiWorkflowLoader.mcpServer = {
      tools,
      listTools(streamName = null) {
        const all = [...tools.values()];
        if (!streamName) return all.filter((t) => !String(t.name).startsWith('chat.'));
        const prefix = `${streamName}.`;
        return all.filter((t) => String(t.name).startsWith(prefix));
      },
      async handleToolCall({ name, arguments: args }) {
        handleLog.push({ name, args });
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, name, args }) }],
        };
      },
    };

    globalThis.logger = globalThis.logger || {
      mark: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  });

  after(() => {
    AiWorkflowLoader.mcpServer = prevMcp;
  });

  it('白名单：仅 workflows 前缀工具进 OpenAI schema；空 workflows 无工具', () => {
    assert.deepEqual(MCPToolAdapter.convertMCPToolsToOpenAI({}), []);
    assert.deepEqual(MCPToolAdapter.convertMCPToolsToOpenAI({ workflows: [] }), []);

    const listed = MCPToolAdapter.convertMCPToolsToOpenAI({ workflows: ['tools'] });
    assert.deepEqual(
      listed.map((t) => t.function.name).sort(),
      ['tools.echo', 'tools.ping'],
    );
    assert.equal(listed.some((t) => t.function.name === 'chat.reply'), false);
    assert.equal(listed.some((t) => t.function.name.startsWith('remote-mcp.')), false);
  });

  it('E2E：runHarnessModuleLoop 注册白名单工具、执行 handleToolCall、回灌 mcpTools/content', async () => {
    const { importHarnessSdk } = await import('#infrastructure/ai-workflow/harness-resolve.js');
    let harness;
    try {
      harness = await importHarnessSdk();
    } catch {
      return;
    }

    handleLog.length = 0;
    const out = await runHarnessModuleLoop({
      stream: {
        name: 'http-v3',
        _getToolWorkflowNames: () => ['tools'],
      },
      messages: [
        { role: 'system', content: 'use tools when needed' },
        { role: 'user', content: 'echo hi' },
      ],
      config: {
        _harnessLlm: harness.createReplayAdapter([
          {
            content: '',
            toolCalls: [
              { id: 'c_echo', name: 'tools.echo', arguments: { text: 'hi' } },
            ],
          },
          { content: 'echoed-hi', toolCalls: [] },
        ]),
        safety: false,
        maxToolRounds: 3,
      },
      apiConfig: { workflows: ['tools'] },
    });

    assert.ok(handleLog.some((h) => h.name === 'tools.echo'), '须经 MCPServer.handleToolCall');
    assert.ok(out.executedToolNames.includes('tools.echo'));
    assert.equal(out.content, 'echoed-hi');
    assert.ok(Array.isArray(out.mcpTools));
    const card = out.mcpTools.find((t) => t.name === 'tools.echo');
    assert.ok(card, 'mcpTools 须回灌工具卡');
    assert.match(String(card.result ?? ''), /"ok":true/);
    assert.match(String(card.result ?? ''), /tools\.echo/);
    assert.equal(out.executedToolNames.includes('chat.reply'), false);
    assert.equal(out.executedToolNames.includes('remote-mcp.weather.forecast'), false);
  });

  it('越权：白名单外工具名被 adapter 拒绝（不执行 MCP）', async () => {
    handleLog.length = 0;
    const denied = await MCPToolAdapter.handleToolCalls(
      [{ id: 'x1', function: { name: 'chat.reply', arguments: '{}' } }],
      { workflows: ['tools'] },
    );
    assert.equal(denied.length, 1);
    assert.match(denied[0].content, /不在允许的工具列表|不在白名单/);
    assert.equal(handleLog.length, 0);
  });
});
