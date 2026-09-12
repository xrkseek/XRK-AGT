import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'tests/helpers/test-server.mjs');
const API_KEY_FILE = path.join(root, 'config/server_config/api_key.json');

function pickPort() {
  return 19000 + Math.floor(Math.random() * 800);
}

function waitForReady(child, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server boot timeout')), timeoutMs);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('XRK_TEST_READY')) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.on('exit', (code) => {
      if (!buf.includes('XRK_TEST_READY')) {
        clearTimeout(timer);
        reject(new Error(`server exited early: ${code}\n${buf}`));
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** server.auth.loopbackExempt 默认 false；/api/* 须带 X-API-Key（与生产一致） */
function loadApiKey() {
  const raw = JSON.parse(fs.readFileSync(API_KEY_FILE, 'utf8'));
  const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
  if (!key) throw new Error(`empty API key in ${API_KEY_FILE}`);
  return key;
}

function apiHeaders() {
  return { 'X-API-Key': loadApiKey() };
}

describe('HTTP 端到端（真实启动 AgentRuntime）', () => {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  let port;

  before(async () => {
    port = pickPort();
    child = spawn(process.execPath, [helper], {
      cwd: root,
      env: { ...process.env, XRK_TEST: '1', XRK_TEST_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errBuf = '';
    child.stderr?.on('data', (c) => {
      errBuf += c.toString();
    });
    try {
      await waitForReady(child);
    } catch (e) {
      throw new Error(`${e.message}\nstderr:\n${errBuf.slice(-4000)}`);
    }
  }, { timeout: 150000 });

  after(async () => {
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  });

  it('GET /api/plugins/summary 200（X-API-Key）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/summary`, {
      headers: apiHeaders(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.summary != null);
    assert.ok(Array.isArray(body.plugins));
  });

  it('GET /xrk/ 返回 HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/xrk/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /html/i);
  });

  it('GET /api/plugins/tasks 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/tasks`, {
      headers: apiHeaders(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.tasks));
  });

  it('GET /health 存活 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.status);
    assert.ok(typeof body.uptime === 'number');
  });

  it('GET /metrics JSON 与 Prometheus', async () => {
    await fetch(`http://127.0.0.1:${port}/health`);
    const jsonRes = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(jsonRes.status, 200);
    const metrics = await jsonRes.json();
    assert.ok(metrics.memory?.heapUsed >= 0);
    assert.ok(metrics.http?.total >= 1, '入站延迟应已聚合');
    assert.ok(Number.isFinite(metrics.http?.latencyMs?.p99));

    const promRes = await fetch(`http://127.0.0.1:${port}/metrics?format=prometheus`);
    assert.equal(promRes.status, 200);
    const text = await promRes.text();
    assert.match(text, /xrk_nodejs_heap_used_bytes/);
    assert.match(text, /xrk_http_latency_ms_p99/);
  });

  it('GET /api/health 就绪面（200 或 503）', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: apiHeaders(),
    });
    assert.ok(res.status === 200 || res.status === 503, `status=${res.status}`);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.services);
    assert.ok(body.services.redis || body.services.api);
  });
});
