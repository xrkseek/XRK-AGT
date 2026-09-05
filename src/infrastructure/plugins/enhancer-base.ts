import PluginBase from './plugin-base.js';
import { resolveTaskerId } from '#utils/event-keys.js';

/**
 * tasker 短名 → 与 Listener.markTasker / EventNormalizer 一致的旗标。
 * 禁止再用 `is${Capitalize(tasker)}`（会把 onebot 写成 isOnebot，与 isOneBot 并存）。
 */
const TASKER_FLAG = Object.freeze({
  onebot: 'isOneBot',
  opqbot: 'isOpqbot',
  stdin: 'isStdin',
  device: 'isDevice',
}) as Record<string, string>;

function flagForTasker(tasker: string): string {
  if (!tasker) return '';
  return TASKER_FLAG[tasker] || `is${tasker.charAt(0).toUpperCase()}${tasker.slice(1)}`;
}

/**
 * Enhancer 基类：只增强「本 tasker」事件，禁止串台。
 */
export default class EnhancerBase extends (PluginBase as any) {
  tasker: string;

  constructor(config: Record<string, any> = {}) {
    super({
      ...config,
      priority: config.priority || 1,
      rule: config.rule || [],
    });
    this.tasker = config.tasker || '';
  }

  /**
   * @param taskerName resolveTaskerId 结果
   */
  isTargetEvent(_e: Record<string, any>, taskerName: string): boolean {
    if (!this.tasker) return false;
    // 仅按规范短名隔离；勿用旗标 OR，避免脏 flag 串台
    return taskerName === this.tasker;
  }

  enhanceEvent(e: Record<string, any>): void {
    if (!this.tasker) return;

    const flag = flagForTasker(this.tasker);
    if (flag && !e[flag]) e[flag] = true;
    if (flag === 'isOneBot' && e.isOnebot != null && e.isOneBot) delete e.isOnebot;
    e.tasker = this.tasker;

    this.ensureLogText(e, this.name || 'Enhancer', this.getEventScope(e), this.getEventType(e));
  }

  getEventScope(e: Record<string, any>): string {
    return e.group_id ? `group:${e.group_id}` : e.user_id || e.device_id || 'unknown';
  }

  getEventType(e: Record<string, any>): string {
    return e.post_type || 'event';
  }

  setupReply(_e: Record<string, any>): void {}

  applyConfigPolicies(_e: Record<string, any>): boolean | string | Promise<boolean | string> {
    return true;
  }

  applyAlias(_e: Record<string, any>): void {}

  enforceReplyPolicy(_e: Record<string, any>): boolean | string {
    return true;
  }

  async accept(e: Record<string, any>): Promise<boolean | string> {
    const taskerName = resolveTaskerId(e);
    if (!this.isTargetEvent(e, taskerName)) return true;

    this.enhanceEvent(e);

    const cfgResult = await this.applyConfigPolicies(e);
    if (cfgResult === 'return' || cfgResult === false) return cfgResult;

    this.setupReply(e);
    this.applyAlias(e);

    return this.enforceReplyPolicy(e) === 'return' ? 'return' : true;
  }

  ensureLogText(e: Record<string, any>, prefix: string, scope: string, eventType: string): void {
    if (e.logText && !e.logText.includes('未知')) return;
    e.logText = `[${prefix}][${scope}][${eventType}]`;
  }

  safeDefine(obj: Record<string, any>, key: string, getter: () => unknown): void {
    if (obj[key] !== undefined) return;
    try {
      Object.defineProperty(obj, key, {
        get: getter,
        configurable: true,
        enumerable: false,
      });
    } catch {
      /* ignore */
    }
  }

  processAtProperties(_e: Record<string, any>): void {}

  bindBotEntities(e: Record<string, any>): void {
    if (!e.bot) return;

    if (e.user_id && e.bot.pickFriend) {
      this.safeDefine(e, 'friend', () => e.bot.pickFriend(e.user_id));
    }

    if (e.group_id && e.bot.pickGroup) {
      this.safeDefine(e, 'group', () => e.bot.pickGroup(e.group_id));
    }

    if (e.group_id && e.user_id && e.bot.pickMember) {
      this.safeDefine(e, 'member', () => e.bot.pickMember(e.group_id, e.user_id));
    }
  }
}
