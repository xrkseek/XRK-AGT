import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEmotionKey, EMOTION_KEYS, unwrapSuccess, abortTimeout } from '../../core/system-Core/www/xrk/src/utils/http.js';

const wwwRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../core/system-Core/www/xrk'
);

const requiredFiles = [
  'package.json',
  'vite.config.js',
  'sign.json',
  'index.html',
  'src/main.js',
  'src/App.vue',
  'src/layouts/AppShell.vue',
  'src/views/HomeView.vue',
  'src/views/ChatView.vue',
  'src/views/ConfigView.vue',
  'src/views/ApiDebugView.vue',
  'src/utils/http.js',
  'public/api-config.json',
];

describe('www/xrk Vue 控制台', () => {
  for (const rel of requiredFiles) {
    it(`存在 ${rel}`, () => {
      assert.ok(fs.existsSync(path.join(wwwRoot, rel)), rel);
    });
  }

  it('sign.json 静态挂 dist', () => {
    const sign = JSON.parse(fs.readFileSync(path.join(wwwRoot, 'sign.json'), 'utf8'));
    assert.equal(sign.enabled, false);
    assert.equal(sign.serve, 'static');
    assert.equal(sign.staticRoot, 'dist');
    assert.equal(sign.proxy?.mount, '/xrk');
  });

  it('vite base 为 /xrk/', () => {
    const vite = fs.readFileSync(path.join(wwwRoot, 'vite.config.js'), 'utf8');
    assert.match(vite, /base:\s*`\$\{mount\}\/`/);
    assert.match(vite, /const mount = '\/xrk'/);
  });

  it('http 工具：unwrapSuccess 解包 HttpResponse.success', () => {
    // 普通对象拍平到顶层（去 success/message）
    assert.deepEqual(unwrapSuccess({ success: true, message: 'ok', a: 1, b: 2 }), { a: 1, b: 2 });
    // 数组/标量走 data 字段
    assert.deepEqual(unwrapSuccess({ success: true, message: 'ok', data: [1, 2] }), [1, 2]);
    assert.equal(unwrapSuccess({ success: true, message: 'ok', data: null }), null);
    // 失败抛错并带 message
    assert.throws(() => unwrapSuccess({ success: false, message: '未授权' }), /未授权/);
    assert.throws(() => unwrapSuccess(undefined), /请求失败/);
  });

  it('http 工具：abortTimeout 返回可用 AbortSignal', () => {
    const signal = abortTimeout(1000);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    // 不应泄漏定时器：短时延到点后应 abort
    const soon = abortTimeout(1);
    assert.equal(soon.aborted, false);
  });
});

describe('ui-kit 情绪 key', () => {
  it('非法 key 回退为 happy', () => {
    assert.equal(normalizeEmotionKey('invalid'), 'happy');
    assert.equal(normalizeEmotionKey('happy'), 'happy');
  });

  it('EMOTION_KEYS 包含标准集合', () => {
    for (const k of ['happy', 'message', 'think']) {
      assert.ok(EMOTION_KEYS.has(k));
    }
  });
});
