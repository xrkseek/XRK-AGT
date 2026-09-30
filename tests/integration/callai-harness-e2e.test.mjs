/**
 * 办事助手入口：AiWorkflow.callAI → harness（replay）端到端。
 * system+user → { content, steps, sessionId }（不经真实 LLM / 不起服）。
 * @see docs/harness-module-loop.md · docs/ai-workflow.md · docs/agent-context.md
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importHarnessAi } from '../helpers/harness-ai.mjs';

describe('办事助手 callAI → harness（replay）E2E', () => {
  /** @type {string | undefined} */
  let tempDir;
  const prevDir = process.env.XRK_HARNESS_SESSIONS_DIR;
  const prevMem = process.env.XRK_HARNESS_SESSION_MEMORY;

  after(async () => {
    try {
      const { resetHarnessSessionRegistryForTests } = await importHarnessAi('session');
      resetHarnessSessionRegistryForTests();
    } catch {
      /* ignore */
    }
    if (prevDir === undefined) delete process.env.XRK_HARNESS_SESSIONS_DIR;
    else process.env.XRK_HARNESS_SESSIONS_DIR = prevDir;
    if (prevMem === undefined) delete process.env.XRK_HARNESS_SESSION_MEMORY;
    else process.env.XRK_HARNESS_SESSION_MEMORY = prevMem;
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('callAI(system+user) 返回 content / steps / sessionId', async () => {
    const { importHarnessSdk } = await import('#infrastructure/ai-workflow/harness-resolve.js');
    const { default: AiWorkflow } = await importHarnessAi('aiWorkflow');
    const { resetHarnessSessionRegistryForTests } = await importHarnessAi('session');

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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-callai-e2e-'));
    process.env.XRK_HARNESS_SESSIONS_DIR = tempDir;
    delete process.env.XRK_HARNESS_SESSION_MEMORY;
    resetHarnessSessionRegistryForTests();

    const stream = new AiWorkflow({
      name: 'chat',
      description: '办事助手 callAI harness e2e',
    });

    const sessionKey = `callai-e2e-${Date.now().toString(36)}`;
    const out = await stream.callAI(
      [
        { role: 'system', content: '你是办事助手。' },
        { role: 'user', content: 'ping' },
      ],
      {
        sessionKey,
        workflows: [],
        safety: false,
        _harnessLlm: harness.createReplayAdapter([
          { content: 'callai-ok', toolCalls: [] },
        ]),
      }
    );

    assert.ok(out, 'callAI 不应返回 null');
    assert.equal(out.content, 'callai-ok');
    assert.ok(out.sessionId, '须带回 sessionId');
    assert.equal(typeof out.steps, 'number');
    assert.ok(out.steps >= 1, `steps 应 ≥1，实际 ${out.steps}`);
    assert.deepEqual(out.executedToolNames, []);
  });
});
