/**
 * Persistent harness session store under an isolated temp dir (not shared data/harness-sessions).
 * Env: XRK_HARNESS_SESSIONS_DIR forces disk even under node:test.
 * @see src/infrastructure/ai-workflow/harness-session-registry.ts · docs/harness-module-loop.md
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHarnessAi } from '../helpers/harness-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SESSIONS = path.join(root, 'data', 'harness-sessions');

describe('harness session persistent store (isolated dir)', () => {
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

  it('default path is data/harness-sessions; test uses isolated temp + cleans up', async () => {
    assert.ok(DEFAULT_SESSIONS.replace(/\\/g, '/').endsWith('data/harness-sessions'));

    const { importHarnessSdk } = await import('#infrastructure/ai-workflow/harness-resolve.js');
    const {
      getHarnessSessionStore,
      acquireHarnessSession,
      resetHarnessSessionRegistryForTests,
      sanitizeHarnessSessionId,
    } = await importHarnessAi('session');

    let harness;
    try {
      harness = await importHarnessSdk();
    } catch {
      return;
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xrk-harness-sessions-'));
    assert.notEqual(path.resolve(tempDir), path.resolve(DEFAULT_SESSIONS));

    process.env.XRK_HARNESS_SESSIONS_DIR = tempDir;
    delete process.env.XRK_HARNESS_SESSION_MEMORY;
    resetHarnessSessionRegistryForTests();

    const conversationKey = `persist-${Date.now().toString(36)}`;
    const expectedId = sanitizeHarnessSessionId(`agt_${conversationKey}`);

    const first = acquireHarnessSession(harness, conversationKey);
    assert.equal(first.reused, false);
    assert.equal(first.sessionId, expectedId);

    const store = getHarnessSessionStore(harness);
    const tools = harness.createToolRegistry();
    const agent = harness.createAgent({
      sessionId: first.sessionId,
      store,
      llm: harness.createReplayAdapter([{ content: 'disk-ok', toolCalls: [] }]),
      tools,
      safety: false,
      system: 'persist-test',
    });
    const turn = await agent.continueTurn({ text: 'ping' });
    assert.equal(turn.text, 'disk-ok');

    const onDisk = fs.readdirSync(tempDir);
    assert.ok(onDisk.includes('sessions.db'), `expected sessions.db under temp dir, got ${onDisk.join(',')}`);
    assert.ok(
      !tempDir.startsWith(DEFAULT_SESSIONS) && path.resolve(tempDir) !== path.resolve(DEFAULT_SESSIONS),
      'temp dir must be isolated from data/harness-sessions',
    );

    // Close process store and reopen from same dir → session still present
    resetHarnessSessionRegistryForTests();
    const second = acquireHarnessSession(harness, conversationKey);
    assert.equal(second.sessionId, expectedId);
    assert.equal(second.reused, true);
    assert.equal(second.store.has(expectedId), true);

    resetHarnessSessionRegistryForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(tempDir), false);
    tempDir = undefined;
  });
});
