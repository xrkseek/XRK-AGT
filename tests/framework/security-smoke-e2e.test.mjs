/**
 * E2E 安全烟测：鉴权拒绝/放行、上传文件名、路径穿越拒绝。
 * 穿越样例复用 input-path-fuzz；鉴权对真实 /api 探活。
 * @see docs/AUTH.md · tests/framework/input-path-fuzz.test.mjs · docs/框架测试指南.md
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputValidator } from '#utils/input-validator.js';
import { RuntimeError } from '#utils/error-handler.js';
import { decodeMulterFilename } from '#utils/multipart-filename.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'tests/helpers/test-server.mjs');
const API_KEY_FILE = path.join(root, 'config/server_config/api_key.json');
const dataRoot = path.join(root, 'data');

/** 与 input-path-fuzz.test.mjs 同源穿越族（抬到 e2e 烟测） */
const TRAVERSAL = [
  '../etc/passwd',
  '..\\..\\windows\\system32',
  'server_bots/../../etc/passwd',
  'server_bots/../../../etc/passwd',
  './../secret',
  'foo/./../../bar',
  '%2e%2e/%2e%2e/etc/passwd',
  '..%2f..%2fetc/passwd',
];

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

function loadApiKey() {
  const raw = JSON.parse(fs.readFileSync(API_KEY_FILE, 'utf8'));
  const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
  if (!key) throw new Error(`empty API key in ${API_KEY_FILE}`);
  return key;
}

describe('安全烟测 E2E：鉴权 · 上传名 · 路径穿越', () => {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  let port;
  let apiKey;

  before(async () => {
    apiKey = loadApiKey();
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

  it('鉴权拒绝：无 X-API-Key → /api/* 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/summary`);
    assert.equal(res.status, 401);
  });

  it('鉴权拒绝：错误 Key → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/summary`, {
      headers: { 'X-API-Key': '111' },
    });
    assert.equal(res.status, 401);
  });

  it('鉴权放行：正确 X-API-Key → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/summary`, {
      headers: { 'X-API-Key': apiKey },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it('上传文件名：decodeMulterFilename 去路径段 + 纠 mojibake', () => {
    assert.equal(decodeMulterFilename('a/b/../../c.txt'), 'c.txt');
    assert.equal(decodeMulterFilename('..\\..\\evil.exe'), 'evil.exe');
    const orig = '报告.pdf';
    const mojibake = Buffer.from(orig, 'utf8').toString('latin1');
    assert.equal(decodeMulterFilename(mojibake), orig);
  });

  it('路径穿越拒绝：复用 input-path-fuzz TRAVERSAL', () => {
    for (const sample of TRAVERSAL) {
      assert.throws(
        () => InputValidator.validatePath(sample, dataRoot),
        RuntimeError,
        sample,
      );
    }
    const ok = InputValidator.validatePath('server_bots/demo/config.yaml', dataRoot);
    assert.ok(ok.includes('server_bots'));
  });
});
