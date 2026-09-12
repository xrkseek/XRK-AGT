/**
 * 最小事件回环：Tasker 短名派发 → events Listener（去重/markTasker）→ PluginLoader.deal
 * 对照：docs/事件系统标准化文档.md · skill xrk-tasker · 原版 core/system-Core/events/*.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { bootstrapTestEnv } from '../helpers/bootstrap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Tasker/events → PluginLoader.deal 回环', () => {
  /** @type {import('../../dist/src/infrastructure/plugins/loader.js').default | null} */
  let PluginLoaderRef = null;

  before(bootstrapTestEnv);

  after(async () => {
    try {
      await PluginLoaderRef?.destroy?.();
    } catch {
      /* ignore */
    }
  });

  it('stdin/onebot/device Listener 源码均 markProcessed → plugins.deal（与原版一致）', () => {
    for (const name of ['stdin', 'onebot', 'device']) {
      const src = fs.readFileSync(
        path.join(root, `core/system-Core/events/${name}.ts`),
        'utf8',
      );
      assert.match(src, /markProcessed\s*\(/, name);
      assert.match(src, /this\.plugins\.deal\s*\(/, name);
      assert.match(src, /markTasker\s*\(/, name);
    }
  });

  it('mock stdin.message：去重 + tasker 标记 + deal 内 normalizeEventPayload', async () => {
    const { default: StdinEvent } = await import(
      '../../dist/core/system-Core/events/stdin.js'
    );
    const { default: PluginLoader } = await import(
      '../../dist/src/infrastructure/plugins/loader.js'
    );
    PluginLoaderRef = PluginLoader;

    const bot = new EventEmitter();
    bot.makeLog = () => {};
    const listener = new StdinEvent();
    listener.bot = bot;

    /** @type {object[]} */
    const dealt = [];
    listener.plugins = {
      deal: async (e) => {
        // 真实标准化（不去跑全量插件图，避免挂起）
        PluginLoader.normalizeEventPayload(e);
        dealt.push(e);
      },
    };

    await listener.init();

    const e = {
      post_type: 'message',
      message_type: 'private',
      user_id: 'u1',
      message: [{ type: 'text', text: 'ping' }],
      event_id: 'loopback-stdin-1',
    };

    bot.emit('stdin.message', e);
    // handleEvent 是 async，等微任务
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(dealt.length, 1, '应进入 deal 一次');
    assert.equal(dealt[0].tasker, 'stdin');
    assert.equal(dealt[0].isStdin, true);
    assert.equal(dealt[0].isMaster, true);
    assert.ok(dealt[0].event_id);
    assert.equal(dealt[0].post_type, 'message');
    // normalizeEventPayload 初始化媒体字段
    assert.ok(Array.isArray(dealt[0].img));
    assert.ok(Array.isArray(dealt[0].video));
    assert.ok(Array.isArray(dealt[0].audio));
    assert.equal(typeof dealt[0].msg, 'string');

    // 同 event_id 再发：markProcessed 拦截，不二次 deal
    bot.emit('stdin.message', { ...e, message: [{ type: 'text', text: 'again' }] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(dealt.length, 1, '去重后不应再次 deal');
  });

  it('mock device.message：短名派发到 Listener 再进 deal', async () => {
    const { default: DeviceEvent } = await import(
      '../../dist/core/system-Core/events/device.js'
    );
    const { default: PluginLoader } = await import(
      '../../dist/src/infrastructure/plugins/loader.js'
    );
    PluginLoaderRef = PluginLoader;

    const bot = new EventEmitter();
    const listener = new DeviceEvent();
    listener.bot = bot;
    /** @type {object[]} */
    const dealt = [];
    listener.plugins = {
      deal: async (e) => {
        PluginLoader.normalizeEventPayload(e);
        dealt.push(e);
      },
    };
    await listener.init();

    bot.emit('device.message', {
      post_type: 'message',
      user_id: 'd1',
      device_id: 'dev-1',
      message: [{ type: 'text', text: 'hi' }],
      event_id: 'loopback-device-1',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(dealt.length, 1);
    assert.equal(dealt[0].tasker, 'device');
    assert.equal(dealt[0].isDevice, true);
  });
});
