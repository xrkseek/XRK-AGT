import fs from 'node:fs';
import path from 'node:path';
import lodash from 'lodash';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import { registerShutdownHook } from '#utils/process-signals.js';
import { normalizeError } from '#utils/normalize-error.js';
import Renderer, { type DealTplData, type RendererMeta } from './Renderer.js';

/** Puppeteer / Playwright browser 最小共用面 */
export type BrowserLike = {
  pages?: () => Promise<Array<{ close: () => Promise<unknown> }>>;
  contexts?: () => Array<{ close: () => Promise<unknown> }>;
  close: () => Promise<unknown>;
  disconnect?: () => void;
  process?: () => { kill?: (signal?: string) => void } | null;
  wsEndpoint?: () => string;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  isConnected?: () => boolean;
  newContext?: (opts?: unknown) => Promise<unknown>;
  newPage?: () => Promise<unknown>;
  version?: () => Promise<string> | string;
};

export type BrowserRendererConfig = {
  restartNum?: number;
  maxConcurrent?: number;
  queueWaitTimeout?: number;
  browserInitWaitMax?: number;
  browserOpTimeout?: number;
  wsEndpoint?: string;
  ignoreHTTPSErrors?: boolean;
  [key: string]: unknown;
};

export type ScreenshotData = DealTplData & {
  priority?: boolean;
  userTriggered?: boolean;
  queueWaitTimeout?: number;
  multiPageHeight?: number;
  multiPage?: boolean;
  imgType?: string;
  omitBackground?: boolean;
  quality?: number;
  path?: string;
  _baseUrl?: string;
  sys?: { scale?: number };
  pageGotoParams?: Record<string, unknown>;
};

type RedisLike = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { EX?: number }) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
};

/**
 * 浏览器截图渲染器基类（Puppeteer / Playwright 共用）
 *
 * 队列维度：
 * - 普通槽 shoting：受 maxConcurrent 限制
 * - 用户优先槽 shotingUser：data.priority / userTriggered 时独占一条（与 Yunzai 对齐）
 * - 槽位 id 唯一，禁止用模板 name 入队（同名并发会误清）
 * - 排队有超时，避免无限等待
 *
 * 僵死恢复：
 * - ensureBrowserHealthy / safeCloseBrowser：探测失败或 close 卡住时丢弃实例并强杀
 * - 截图出现 timeout/disconnected 时 forceRestart，避免必须重启整个进程
 */
export default class BrowserRendererBase extends Renderer {
  logTag = '';
  /** 浏览器句柄：类字段；ensureLoaded / 首次截图前保持 null */
  browser: BrowserLike | null = null;
  lock = false;
  shoting: string[] = [];
  shotingUser: string[] = [];
  mac = '';
  browserMacKey: string | null = null;
  config: BrowserRendererConfig;
  restartNum = 100;
  renderNum = 0;
  maxConcurrent = 3;
  /** 排队等待默认超时（可被 data.queueWaitTimeout / 渲染器 timeout 覆盖） */
  queueWaitTimeoutMs = 120000;
  /** init 锁等待；超时后清锁，避免 launch 挂死导致永久唤不起来 */
  browserInitWaitMs = 60000;
  /** close / 健康探测超时 */
  browserOpTimeoutMs = 8000;
  healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  _unregisterShutdownHook: (() => void) | null = null;
  _restarting = false;

  constructor(meta: RendererMeta, config: BrowserRendererConfig = {}, logTag: string) {
    super(meta);
    this.config = config;
    this.logTag = logTag;
    this.restartNum = config.restartNum ?? this.restartNum;
    this.maxConcurrent = Math.max(1, Number(config.maxConcurrent) || this.maxConcurrent);
    this.queueWaitTimeoutMs =
      Number.isFinite(config.queueWaitTimeout) && (config.queueWaitTimeout as number) > 0
        ? (config.queueWaitTimeout as number)
        : this.queueWaitTimeoutMs;
    this.browserInitWaitMs =
      Number.isFinite(config.browserInitWaitMax) && (config.browserInitWaitMax as number) > 0
        ? (config.browserInitWaitMax as number)
        : this.browserInitWaitMs;
    this.browserOpTimeoutMs =
      Number.isFinite(config.browserOpTimeout) && (config.browserOpTimeout as number) > 0
        ? (config.browserOpTimeout as number)
        : this.browserOpTimeoutMs;
    this._unregisterShutdownHook = registerShutdownHook(() => {
      const cleanup = (this as { cleanup?: () => unknown }).cleanup;
      if (typeof cleanup === 'function') void cleanup.call(this);
    });
  }

  activeSlotCount() {
    return this.shoting.length + this.shotingUser.length;
  }

  isUserPriority(data: ScreenshotData = { tplFile: '' }) {
    return data.priority === true || data.userTriggered === true;
  }

  makeScreenshotSlotId(name: unknown) {
    const label = String(name || 'shot').slice(0, 64);
    return `${label}#${Date.now().toString(36)}#${Math.random().toString(36).slice(2, 8)}`;
  }

  resolveQueueWaitMs(data: ScreenshotData = { tplFile: '' }, rendererTimeout?: number) {
    if (Number.isFinite(data.queueWaitTimeout) && (data.queueWaitTimeout as number) > 0) {
      return data.queueWaitTimeout as number;
    }
    if (Number.isFinite(rendererTimeout) && (rendererTimeout as number) > 0) {
      return rendererTimeout as number;
    }
    return this.queueWaitTimeoutMs;
  }

  /**
   * 原子占槽：检查与 push 之间无 await，避免同 tick 超并发。
   */
  async acquireScreenshotSlot(
    name: unknown,
    data: ScreenshotData = { tplFile: '' },
    rendererTimeout?: number,
  ): Promise<{ slotId: string; userPriority: boolean } | null> {
    const userPriority = this.isUserPriority(data);
    const slotId = this.makeScreenshotSlotId(name);
    const queueWaitMs = this.resolveQueueWaitMs(data, rendererTimeout);
    const waitStart = Date.now();

    for (;;) {
      if (userPriority) {
        if (this.shotingUser.length < 1) {
          this.shotingUser.push(slotId);
          return { slotId, userPriority };
        }
      } else if (this.activeSlotCount() < this.maxConcurrent) {
        this.shoting.push(slotId);
        return { slotId, userPriority };
      }

      if (Date.now() - waitStart > queueWaitMs) {
        RuntimeUtil.makeLog(
          'error',
          `[${name}] 渲染队列等待超时 (${queueWaitMs}ms)，slots=${this.shoting.length}+${this.shotingUser.length}`,
          this.logTag,
        );
        return null;
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
  }

  releaseScreenshotSlot(slotId: string | null | undefined, userPriority = false) {
    if (!slotId) return;
    const list = userPriority ? this.shotingUser : this.shoting;
    const i = list.indexOf(slotId);
    if (i >= 0) list.splice(i, 1);
  }

  isFatalBrowserError(err: unknown) {
    const msg = Error.isError(err) ? err.message : String(err ?? '');
    return /timeout|timed out|disconnected|Target closed|Session closed|Protocol error|Browser closed|Navigation failed|net::ERR/i.test(
      msg,
    );
  }

  async withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 立即丢弃 this.browser，避免后续请求继续命中僵死实例。
   */
  detachBrowser(): BrowserLike | null {
    const browser = this.browser;
    this.browser = null;
    this.clearHealthCheckTimer();
    return browser;
  }

  /** close 卡住时 disconnect / SIGKILL，不阻塞业务线程过久 */
  async safeCloseBrowser(browser: BrowserLike | null | undefined, closeTimeoutMs = this.browserOpTimeoutMs) {
    if (!browser) return;
    try {
      await this.withTimeout(
        (async () => {
          try {
            if (typeof browser.pages === 'function') {
              const pages = await browser.pages();
              for (const page of pages) await page.close().catch(() => {});
            } else if (typeof browser.contexts === 'function') {
              for (const ctx of browser.contexts()) await ctx.close().catch(() => {});
            }
          } catch {
            /* ignore */
          }
          await browser.close().catch(() => {});
        })(),
        closeTimeoutMs,
        'browser close',
      );
    } catch {
      try {
        browser.disconnect?.();
      } catch {
        /* ignore */
      }
      try {
        browser.process?.()?.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * @returns 探测是否健康
   */
  async ensureBrowserHealthy(ping: (browser: BrowserLike) => Promise<void>): Promise<boolean> {
    if (!this.browser) return false;
    try {
      await this.withTimeout(Promise.resolve(ping(this.browser)), this.browserOpTimeoutMs, 'browser health');
      return true;
    } catch (e: unknown) {
      RuntimeUtil.makeLog('warn', `Existing browser invalid: ${normalizeError(e).message}`, this.logTag);
      const browser = this.detachBrowser();
      await this.removeStoredEndpoint();
      await this.safeCloseBrowser(browser);
      return false;
    }
  }

  async waitForInitLock() {
    if (!this.lock) return this.browser ?? true;

    const deadline = Date.now() + this.browserInitWaitMs;
    while (this.lock && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
      if (this.browser) return this.browser;
    }

    if (this.browser) return this.browser;
    if (this.lock) {
      RuntimeUtil.makeLog(
        'warn',
        `Browser init lock wait timeout (${this.browserInitWaitMs}ms), clearing stuck lock`,
        this.logTag,
      );
      this.lock = false;
      return false;
    }
    return true;
  }

  async ensureMac(redisKeyPrefix: string) {
    if (this.mac) return;
    this.mac = await this.getMac();
    this.browserMacKey = `${redisKeyPrefix}:${this.mac}`;
  }

  async resolveWsEndpoint(): Promise<string | null> {
    const redis = (globalThis as { redis?: RedisLike }).redis;
    let endpoint: string | null = null;
    if (this.browserMacKey && redis) {
      try {
        endpoint = await redis.get(this.browserMacKey);
      } catch {
        /* ignore */
      }
    }
    return endpoint || (typeof this.config?.wsEndpoint === 'string' ? this.config.wsEndpoint : null);
  }

  async persistWsEndpoint(endpoint: string | null | undefined) {
    const redis = (globalThis as { redis?: RedisLike }).redis;
    if (!endpoint || !this.browserMacKey || !redis) return;
    try {
      await redis.set(this.browserMacKey, endpoint, { EX: 60 * 60 * 24 * 30 });
    } catch (err: unknown) {
      RuntimeUtil.makeLog(
        'error',
        `Failed to save browser instance: ${normalizeError(err).message}`,
        this.logTag,
      );
    }
  }

  async removeStoredEndpoint(expectedEndpoint: string | null = null) {
    const redis = (globalThis as { redis?: RedisLike }).redis;
    if (!this.browserMacKey || !redis) return;
    try {
      if (expectedEndpoint) {
        const stored = await redis.get(this.browserMacKey);
        if (stored !== expectedEndpoint) return;
      }
      await redis.del(this.browserMacKey);
    } catch {
      /* ignore */
    }
  }

  prepareScreenshotFile(name: string, data: ScreenshotData) {
    data._baseUrl = Renderer.toFileUrl(paths.root);
    const pageHeight = data.multiPageHeight ?? 4000;
    const savePath = this.dealTpl(name, data);
    if (!savePath) return null;

    const filePath = path.join(paths.root, lodash.trimStart(savePath, '.'));
    if (!fs.existsSync(filePath)) {
      RuntimeUtil.makeLog('error', `HTML file does not exist: ${filePath}`, this.logTag);
      return null;
    }

    return { filePath, pageHeight };
  }

  buildScreenshotOptions(data: ScreenshotData) {
    const screenshotOptions: {
      type: string;
      omitBackground: boolean;
      quality?: number;
      path: string;
    } = {
      type: data.imgType ?? 'jpeg',
      omitBackground: data.omitBackground ?? false,
      quality: data.quality ?? 85,
      path: data.path ?? '',
    };

    if (data.imgType === 'png') delete screenshotOptions.quality;
    return screenshotOptions;
  }

  finishScreenshotRun(name: string, ret: unknown[], data: ScreenshotData) {
    if (this.renderNum % this.restartNum === 0 && this.renderNum > 0 && this.activeSlotCount() === 0) {
      RuntimeUtil.makeLog(
        'info',
        `Completed ${this.renderNum} screenshots, restarting browser...`,
        this.logTag,
      );
      setTimeout(() => void this.restart(), 2000);
    }

    if (ret.length === 0 || !ret[0]) {
      RuntimeUtil.makeLog('error', `[${name}] Screenshot result is empty`, this.logTag);
      return false;
    }

    return data.multiPage ? ret : ret[0];
  }

  clearHealthCheckTimer() {
    if (!this.healthCheckTimer) return;
    clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
  }

  /** launch 时去掉 connect 专用字段，避免脏参数 */
  buildBrowserLaunchOptions(extra: Record<string, unknown> = {}) {
    const { wsEndpoint: _ws, ignoreHTTPSErrors: _https, ...rest } = {
      ...(this.config || {}),
      ...extra,
    };
    return rest;
  }

  /**
   * 强制关闭并丢弃浏览器。force 时忽略 lock / 计数条件，且 close 带超时。
   */
  async restart(force = false) {
    if (this._restarting) return;
    if (!force) {
      if (!this.browser || this.lock) return;
      if (this.renderNum % this.restartNum !== 0 || this.activeSlotCount() > 0) return;
    } else if (!this.browser && !this.lock) {
      await this.removeStoredEndpoint();
      return;
    }

    this._restarting = true;
    RuntimeUtil.makeLog('warn', `Browser ${force ? 'forced' : 'scheduled'} restart...`, this.logTag);

    let currentEndpoint: string | null = null;
    try {
      currentEndpoint = this.browser?.wsEndpoint?.() ?? null;
    } catch {
      /* ignore */
    }

    const browser = this.detachBrowser();
    this.renderNum = 0;
    if (force) this.lock = false;

    try {
      await this.safeCloseBrowser(browser);
      await this.removeStoredEndpoint(currentEndpoint);
      if (typeof globalThis.gc === 'function') globalThis.gc();
      RuntimeUtil.makeLog('info', 'Browser restart completed', this.logTag);
    } catch (err: unknown) {
      RuntimeUtil.makeLog('error', `Restart failed: ${normalizeError(err).message}`, this.logTag);
    } finally {
      this._restarting = false;
    }

    return true;
  }

  /** 截图致命错误：立刻 detach，后台 close，下次 screenshot 会重新 launch */
  handleFatalScreenshotError(error: unknown) {
    if (!this.isFatalBrowserError(error)) return;
    const msg = Error.isError(error) ? error.message : String(error);
    RuntimeUtil.makeLog('warn', `Fatal browser error, scheduling restart: ${msg}`, this.logTag);
    void this.restart(true);
  }
}
