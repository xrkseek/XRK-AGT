/**
 * 通道面 E2E：mock stdin Tasker 短名派发 → events Listener → PluginLoader.deal → e.reply
 * @see docs/事件系统标准化文档.md · .cursor/skills/xrk-tasker/SKILL.md · docs/tasker-base-spec.md
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bootstrapTestEnv } from '../helpers/bootstrap.mjs';
import { getRuntimeGlobal } from '#utils/runtime-globals.js';

describe('通道面：stdin/mock Tasker → events → deal → reply', () => {
  /** @type {import('../../dist/src/infrastructure/plugins/loader.js').default} */
  let PluginLoader;
  /** @type {unknown[]} */
  let prevPriority;
  /** @type {unknown[]} */
  let prevExtended;
  /** @type {unknown[]} */
  let prevDefaultHandlers;

  before(async () => {
    await bootstrapTestEnv();
    ({ default: PluginLoader } = await import(
      '../../dist/src/infrastructure/plugins/loader.js'
    ));
    prevPriority = PluginLoader.priority;
    prevExtended = PluginLoader.extended;
    prevDefaultHandlers = PluginLoader.defaultMsgHandlers;
  });

  after(async () => {
    if (PluginLoader) {
      PluginLoader.priority = prevPriority || [];
      PluginLoader.extended = prevExtended || [];
      PluginLoader.defaultMsgHandlers = prevDefaultHandlers || [];
      try {
        await PluginLoader.destroy?.();
      } catch {
        /* ignore */
      }
    }
  });

  it('mock stdin.message：Listener→deal→插件 e.reply 回灌通道', async () => {
    const PluginBase = getRuntimeGlobal('PluginBase');
    assert.equal(typeof PluginBase, 'function', 'bootstrap 须挂载 PluginBase');

    class ChannelEchoPlugin extends PluginBase {
      constructor() {
        super({
          name: 'channel-echo-e2e',
          dsc: '通道面 e2e',
          event: 'stdin.message',
          priority: 0,
          rule: [{ reg: /^ping$/i, fnc: 'onPing' }],
        });
      }

      async onPing(e) {
        await e.reply('pong-channel');
        return true;
      }
    }

    const ruleTemplates = PluginLoader.prepareRuleTemplates([
      { reg: /^ping$/i, fnc: 'onPing' },
    ]);

    PluginLoader.priority = [
      {
        class: ChannelEchoPlugin,
        key: 'channel-echo-e2e',
        name: 'channel-echo-e2e',
        event: 'stdin.message',
        priority: 0,
        bypassThrottle: true,
        taskers: null,
        ruleTemplates,
        bypassRules: [],
        isEnhancer: false,
      },
    ];
    PluginLoader.extended = [];
    PluginLoader.defaultMsgHandlers = [];

    const { default: StdinEvent } = await import(
      '../../dist/core/system-Core/events/stdin.js'
    );

    const bot = new EventEmitter();
    bot.makeLog = () => {};
    bot.uin = ['stdin'];
    const listener = new StdinEvent();
    listener.bot = bot;
    listener.plugins = PluginLoader;
    await listener.init();

    /** @type {unknown[]} */
    const replies = [];
    const done = new Promise((resolve) => {
      const e = {
        post_type: 'message',
        message_type: 'private',
        user_id: 'u-channel',
        self_id: 'stdin',
        message: [{ type: 'text', text: 'ping' }],
        event_id: `channel-e2e-${Date.now()}`,
        reply: async (msg) => {
          replies.push(msg);
          return { message_id: 'm1' };
        },
        _onDone: () => resolve(null),
      };
      bot.emit('stdin.message', e);
    });

    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('通道面 deal 超时')), 15000),
      ),
    ]);

    assert.ok(replies.length >= 1, `应至少回复一次，实际 ${replies.length}`);
    const flat = replies
      .map((m) => (typeof m === 'string' ? m : Array.isArray(m) ? m.join('') : String(m)))
      .join('');
    assert.match(flat, /pong-channel/);
  });
});
