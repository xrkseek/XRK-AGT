/**
 * remote-mcp mount / XRK_TEST skip / tool name scope + MCPToolAdapter whitelist
 * @see .cursor/skills/xrk-mcp/SKILL.md · docs/mcp-guide.md
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteMcpController } from '#infrastructure/ai-workflow/remote-mcp.js';
import { MCPToolAdapter } from '#utils/llm/mcp-tool-adapter.js';
import {
  isRemoteMcpStreamName,
  partitionToolStreamNames,
  expandChatToolWorkflowWhitelist,
} from '#infrastructure/ai-workflow/chat-tool-streams.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';

describe('remote-mcp mount + XRK_TEST skip', () => {
  it('loadRemoteMCPServers returns [] when XRK_TEST=1', async () => {
    const prev = process.env.XRK_TEST;
    process.env.XRK_TEST = '1';
    try {
      const tools = new Map();
      const ctrl = new RemoteMcpController({
        getMcpServer: () => ({
          tools,
          registerTool(name, def) {
            tools.set(name, { name, ...def });
          },
        }),
        getMcpPluginServers: () => new Map([['should-not-load', { command: 'echo' }]]),
        makeLog() {},
      });
      const loaded = await ctrl.loadRemoteMCPServers();
      assert.deepEqual(loaded, []);
      assert.equal(tools.size, 0);
      assert.equal(ctrl.remoteMCPServers.size, 0);
    } finally {
      if (prev === undefined) delete process.env.XRK_TEST;
      else process.env.XRK_TEST = prev;
    }
  });

  it('loadRemoteMCPServers returns [] when mcpServer missing (even if XRK_TEST off)', async () => {
    const prev = process.env.XRK_TEST;
    delete process.env.XRK_TEST;
    try {
      const ctrl = new RemoteMcpController({
        getMcpServer: () => null,
        makeLog() {},
      });
      assert.deepEqual(await ctrl.loadRemoteMCPServers(), []);
    } finally {
      if (prev === undefined) delete process.env.XRK_TEST;
      else process.env.XRK_TEST = prev;
    }
  });

  it('_registerRemoteTools names tools remote-mcp.<server>.<tool>', () => {
    const tools = new Map();
    const mcpServer = {
      tools,
      registerTool(name, def) {
        tools.set(name, { name, description: def.description, inputSchema: def.inputSchema, handler: def.handler });
      },
    };
    const ctrl = new RemoteMcpController({
      getMcpServer: () => mcpServer,
      makeLog() {},
    });
    ctrl._registerRemoteTools('weather', [
      { name: 'forecast', description: 'wx', inputSchema: { type: 'object', properties: {} } },
      { name: '', description: 'skip' },
    ]);
    assert.equal(tools.size, 1);
    assert.ok(tools.has('remote-mcp.weather.forecast'));
    const t = tools.get('remote-mcp.weather.forecast');
    assert.equal(t.description, 'wx');
    assert.equal(typeof t.handler, 'function');
  });

  it('listRemoteMCPServers unions plugin + remote maps', () => {
    const ctrl = new RemoteMcpController({
      getMcpServer: () => ({ tools: new Map() }),
      getMcpPluginServers: () => new Map([['plugin-a', {}]]),
      makeLog() {},
    });
    ctrl.remoteMCPServers.set('yaml-b', { type: 'http', url: 'http://127.0.0.1:9', headers: {}, config: {} });
    assert.deepEqual(ctrl.listRemoteMCPServers(), ['plugin-a', 'yaml-b']);
  });
});

describe('tool name scope (remote-mcp.* + adapter workflows)', () => {
  it('isRemoteMcpStreamName / partitionToolStreamNames', () => {
    assert.equal(isRemoteMcpStreamName('remote-mcp.weather'), true);
    assert.equal(isRemoteMcpStreamName('tools'), false);
    const { mergeable, toolOnly } = partitionToolStreamNames([
      'memory',
      'remote-mcp.weather',
      'tools',
      'remote-mcp.db',
    ]);
    assert.deepEqual(mergeable, ['memory', 'tools']);
    assert.deepEqual(toolOnly, ['remote-mcp.weather', 'remote-mcp.db']);
  });

  it('expandChatToolWorkflowWhitelist does not auto-include remote-mcp.*', () => {
    const names = expandChatToolWorkflowWhitelist(['memory', 'tools']);
    assert.ok(names.includes('memory'));
    assert.equal(names.some((n) => String(n).startsWith('remote-mcp.')), false);
  });

  let prevMcp;
  before(() => {
    prevMcp = AiWorkflowLoader.mcpServer;
  });
  after(() => {
    AiWorkflowLoader.mcpServer = prevMcp;
  });

  it('MCPToolAdapter scopes by workflows prefix; empty workflows → no tools', async () => {
    const tools = new Map([
      ['tools.read', { name: 'tools.read', description: 'r', inputSchema: {} }],
      ['remote-mcp.weather.forecast', { name: 'remote-mcp.weather.forecast', description: 'w', inputSchema: {} }],
      ['remote-mcp.db.query', { name: 'remote-mcp.db.query', description: 'q', inputSchema: {} }],
      ['chat.reply', { name: 'chat.reply', description: 'c', inputSchema: {} }],
    ]);
    AiWorkflowLoader.mcpServer = {
      tools,
      listTools(streamName = null) {
        const all = [...tools.values()];
        if (!streamName) return all.filter((t) => !t.name.startsWith('chat.'));
        const prefix = `${streamName}.`;
        return all.filter((t) => t.name.startsWith(prefix));
      },
      async handleToolCall({ name, arguments: args }) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, name, args }) }],
        };
      },
    };

    assert.deepEqual(MCPToolAdapter.listMcpTools({}), []);
    assert.deepEqual(MCPToolAdapter.convertMCPToolsToOpenAI({}), []);

    const weather = MCPToolAdapter.convertMCPToolsToOpenAI({
      workflows: ['remote-mcp.weather'],
    });
    assert.deepEqual(
      weather.map((t) => t.function.name),
      ['remote-mcp.weather.forecast'],
    );

    const mixed = MCPToolAdapter.convertMCPToolsToOpenAI({
      workflows: ['tools', 'remote-mcp.weather'],
    });
    const names = mixed.map((t) => t.function.name).sort();
    assert.deepEqual(names, ['remote-mcp.weather.forecast', 'tools.read']);

    // out-of-scope tool call rejected by adapter whitelist
    const denied = await MCPToolAdapter.handleToolCalls(
      [{ id: 'c1', function: { name: 'remote-mcp.db.query', arguments: '{}' } }],
      { workflows: ['remote-mcp.weather'] },
    );
    assert.equal(denied.length, 1);
    assert.match(denied[0].content, /不在允许的工具列表/);

    const allowed = await MCPToolAdapter.handleToolCalls(
      [{ id: 'c2', function: { name: 'remote-mcp.weather.forecast', arguments: '{"d":1}' } }],
      { workflows: ['remote-mcp.weather'] },
    );
    assert.equal(allowed.length, 1);
    assert.match(allowed[0].content, /"ok":true/);
  });
});
