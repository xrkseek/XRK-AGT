// @ts-nocheck
/** Playwright 受控会话； role ref 快照 + 导航 SSRF 复检 */
import playwright from 'playwright';
import {
  assertBrowserNavigationResultAllowedForPage,
  didCrossDocumentUrlChange,
  gotoWithNavigationGuard,
  normalizePlaywrightWaitUntil
} from './browser-navigation-guard.js';
import {
  armObservedDialogResponseOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  getObservedBrowserStateForPage,
  getPageState,
  isBrowserObservedDialogBlockedError,
  respondToObservedDialogOnPage,
  storeRoleRefsOnPage
} from './pw-page-state.js';
import {
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  parseRoleRef
} from './pw-role-snapshot.js';
import { refLocator, resolveInteractionTarget } from './pw-ref-locator.js';
import {
  ACT_DEFAULT_SNAPSHOT_TIMEOUT_MS,
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  ACT_MAX_SNAPSHOT_TIMEOUT_MS,
  clampInteractionTimeoutMs,
  clampWaitTimeoutMs,
  clampWaitTimeMs,
  INTERACTION_NAVIGATION_GRACE_MS
} from './act-policy.js';
import { DEFAULT_DEVICE_SCALE_FACTOR } from './page-screenshot-enhance.js';
import { connectPlaywrightBrowser, launchPlaywrightBrowser } from '#utils/playwright-puppeteer-compat.js';
import { isPlaywrightCrashError, softClosePlaywright, softClosePlaywrightTree } from './playwright-crash.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { normalizeError } from '#utils/normalize-error.js';

const BROWSER_TYPES = /** @type {const} */ (['chromium', 'firefox', 'webkit']);
const DEFAULT_USING_CRASH_RETRIES = 1;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 8_000;

/**
 * @typedef {Object} PlaywrightAgentLaunchOptions
 * @property {'chromium'|'firefox'|'webkit'} [browserType]
 * @property {boolean} [headless]
 * @property {string} [executablePath]
 * @property {string} [wsEndpoint]
 * @property {number} [launchTimeoutMs]
 * @property {string[]} [launchArgs]
 * @property {Record<string, string>} [extraHTTPHeaders]
 * @property {number} [deviceScaleFactor]
 * @property {{ width: number, height: number }} [viewport]
 * @property {number} [navigationTimeoutMs] 会话默认导航超时（来自 buildBrowserRuntime）
 * @property {object} [ssrfPolicy] 会话默认 SSRF 策略
 * @property {number} [closeTimeoutMs] soft close 超时
 * @property {number} [pageCrashRetries] withPageCrashRetry 默认次数
 * @property {number} [opTimeoutMs] capture 等可选整段超时；未设则不限
 */

/**
 * @typedef {Object} PlaywrightAgentUsingOptions
 * @property {number} [crashRetries=1] 整轮回调遇 Target/Page crashed 时换新浏览器重试次数
 */

function clampInt(raw, min, max, fallback) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampSnapshotTimeoutMs(raw) {
  const n = Math.floor(Number(raw) || ACT_DEFAULT_SNAPSHOT_TIMEOUT_MS);
  return Math.min(ACT_MAX_SNAPSHOT_TIMEOUT_MS, Math.max(500, n));
}

export class PlaywrightAgentSession {
  /**
   * @param {import('playwright').Browser} browser
   * @param {import('playwright').BrowserContext} context
   * @param {import('playwright').Page} page
   * @param {PlaywrightAgentLaunchOptions} [launchOptions]
   */
  constructor(browser, context, page, launchOptions = {}) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    /** @type {PlaywrightAgentLaunchOptions} */
    this.launchOptions = launchOptions;
    this.navigationTimeoutMs = clampInt(
      launchOptions.navigationTimeoutMs,
      1_000,
      180_000,
      DEFAULT_NAVIGATION_TIMEOUT_MS
    );
    this.ssrfPolicy =
      launchOptions.ssrfPolicy && typeof launchOptions.ssrfPolicy === 'object'
        ? { ...launchOptions.ssrfPolicy }
        : {};
    this.closeTimeoutMs = clampInt(
      launchOptions.closeTimeoutMs,
      500,
      60_000,
      DEFAULT_CLOSE_TIMEOUT_MS
    );
    this.pageCrashRetries = clampInt(launchOptions.pageCrashRetries, 0, 3, 1);
    const opRaw = launchOptions.opTimeoutMs;
    this.opTimeoutMs =
      opRaw == null || opRaw === 0
        ? null
        : clampInt(opRaw, 5_000, 600_000, null);
    /** @type {Record<string, { role: string, name?: string, nth?: number }>} */
    this.roleRefs = {};
    /** @type {{ prepare?: (page: import('playwright').Page) => Promise<void>, apply: (page: import('playwright').Page) => Promise<void>, capture: (page: import('playwright').Page, selector?: string) => Promise<Buffer> } | null} */
    this.screenshotHelper = null;
    this.#applyPageDefaults(page);
  }

  /** @param {import('playwright').Page} page */
  #applyPageDefaults(page) {
    ensurePageState(page);
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    page.setDefaultTimeout(Math.max(this.navigationTimeoutMs, 30_000));
  }

  /** @param {ReturnType<import('./page-screenshot-enhance.js').createLocalFontScreenshotHelper>} helper */
  attachScreenshotHelper(helper) {
    this.screenshotHelper = helper;
    return this;
  }

  /** @param {PlaywrightAgentLaunchOptions} [options] */
  static async launch(options = {}) {
    const {
      browserType = 'chromium',
      headless = true,
      executablePath,
      wsEndpoint,
      launchTimeoutMs = 120_000,
      launchArgs = [],
      extraHTTPHeaders,
      deviceScaleFactor = DEFAULT_DEVICE_SCALE_FACTOR,
      viewport
    } = options;

    if (!BROWSER_TYPES.includes(browserType)) {
      throw new Error(`browserType must be one of: ${BROWSER_TYPES.join(', ')}`);
    }

    const timeout = Math.min(Math.max(launchTimeoutMs, 5_000), 180_000);
    const browser = typeof wsEndpoint === 'string' && wsEndpoint.trim()
      ? await connectPlaywrightBrowser(playwright, browserType, wsEndpoint.trim(), { timeout })
      : await launchPlaywrightBrowser(playwright, browserType, {
          headless,
          executablePath: executablePath || undefined,
          args: launchArgs,
          timeout
        });

    /** @type {import('playwright').BrowserContextOptions} */
    const contextOptions = {};
    if (extraHTTPHeaders && Object.keys(extraHTTPHeaders).length > 0) {
      contextOptions.extraHTTPHeaders = extraHTTPHeaders;
    }
    if (viewport?.width && viewport?.height) {
      contextOptions.viewport = viewport;
    }
    if (Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0) {
      contextOptions.deviceScaleFactor = deviceScaleFactor;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return new PlaywrightAgentSession(browser, context, page, { ...options });
  }

  /**
   * 当前页目标崩溃后换新 Page（保留 browser/context 与截图 helper；不降 DPR）
   * @returns {Promise<import('playwright').Page>}
   */
  async recreatePage() {
    const old = this.page;
    this.roleRefs = {};
    if (old) await softClosePlaywright(old, Math.min(5_000, this.closeTimeoutMs));
    if (!this.context) throw new Error('PlaywrightAgentSession.recreatePage: context 已关闭');
    const page = await this.context.newPage();
    this.#applyPageDefaults(page);
    this.page = page;
    if (this.screenshotHelper?.prepare) await this.screenshotHelper.prepare(page);
    return page;
  }

  /**
   * @template T
   * @param {() => Promise<T>} op
   * @param {{ timeoutMs?: number, label?: string }} [opts]
   */
  async withOpTimeout(op, opts = {}) {
    const raw = opts.timeoutMs ?? this.opTimeoutMs;
    if (raw == null || raw === 0) return op();
    const ms = clampInt(raw, 1_000, 600_000, 0);
    const label = opts.label || 'op';
    if (!ms) return op();
    let timer;
    try {
      return await Promise.race([
        op(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Playwright ${label} 超时 ${ms}ms`)), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} op
   * @param {{ retries?: number, label?: string }} [opts]
   */
  async withPageCrashRetry(op, opts = {}) {
    const retries = clampInt(opts.retries ?? this.pageCrashRetries, 0, 3, 1);
    const label = opts.label || 'op';
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (!isPlaywrightCrashError(err) || attempt >= retries) throw err;
        RuntimeUtil.makeLog(
          'warn',
          `Playwright ${label} 目标崩溃，重建 page 后重试 (${attempt + 1}/${retries})：${normalizeError(err).message}`,
          'PlaywrightSession'
        );
        await this.recreatePage();
      }
    }
    throw lastErr;
  }

  async guardAfterInteraction(previousUrl, ssrfPolicy = {}) {
    await this.page.waitForTimeout(INTERACTION_NAVIGATION_GRACE_MS).catch(() => {});
    const policy = ssrfPolicy && Object.keys(ssrfPolicy).length ? ssrfPolicy : this.ssrfPolicy;
    if (didCrossDocumentUrlChange(this.page, previousUrl)) {
      await assertBrowserNavigationResultAllowedForPage(this.page, policy);
    }
  }

  async goto(url, navOptions = {}) {
    return this.withPageCrashRetry(() => this.#gotoOnce(url, navOptions), {
      retries: this.pageCrashRetries,
      label: 'goto'
    });
  }

  /**
   * @param {string} url
   * @param {{ waitUntil?: string, timeoutMs?: number, skipSsrfCheck?: boolean, ssrfPolicy?: object }} [navOptions]
   */
  async #gotoOnce(url, navOptions = {}) {
    // 官方 Page.goto：默认 load；networkidle 为 DISCOURAGED，仍允许显式传入
    const waitUntil = normalizePlaywrightWaitUntil(navOptions.waitUntil, 'load');
    const timeoutMs = clampInt(
      navOptions.timeoutMs ?? this.navigationTimeoutMs,
      1_000,
      180_000,
      this.navigationTimeoutMs
    );
    const skipSsrfCheck = navOptions.skipSsrfCheck === true;
    const ssrfPolicy =
      navOptions.ssrfPolicy && typeof navOptions.ssrfPolicy === 'object'
        ? navOptions.ssrfPolicy
        : this.ssrfPolicy;

    if (skipSsrfCheck) {
      await this.page.goto(url, { waitUntil, timeout: timeoutMs });
      return;
    }
    await gotoWithNavigationGuard(this.page, url, {
      timeoutMs,
      waitUntil,
      ssrfPolicy,
      onBlocked: async () => {
        await softClosePlaywright(this.page, Math.min(3_000, this.closeTimeoutMs));
      }
    });
  }

  async listTabs() {
    const pages = this.context.pages();
    const tabs = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      tabs.push({
        index: i,
        active: p === this.page,
        url: p.url(),
        title: await p.title().catch(() => '')
      });
    }
    return tabs;
  }

  async newTab(url = 'about:blank', opts = {}) {
    const page = await this.context.newPage();
    this.#applyPageDefaults(page);
    this.page = page;
    if (url && url !== 'about:blank') {
      await this.goto(url, {
        ssrfPolicy: opts.ssrfPolicy ?? this.ssrfPolicy,
        timeoutMs: opts.timeoutMs ?? this.navigationTimeoutMs,
        waitUntil: opts.waitUntil
      });
    }
    return { index: this.context.pages().indexOf(page), url: page.url() };
  }

  async closeTab(index) {
    const pages = this.context.pages();
    if (pages.length <= 1) throw new Error('Cannot close the last tab');
    const idx = typeof index === 'number' ? index : pages.indexOf(this.page);
    if (idx < 0 || idx >= pages.length) throw new Error('Tab index out of range');
    const target = pages[idx];
    const wasActive = target === this.page;
    await softClosePlaywright(target, this.closeTimeoutMs);
    if (wasActive) {
      const remaining = this.context.pages();
      this.page = remaining[Math.min(idx, remaining.length - 1)] ?? remaining[0];
      if (this.page) this.#applyPageDefaults(this.page);
    }
    return { closedIndex: idx, activeUrl: this.url() };
  }

  async focusTab(index) {
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) throw new Error('Tab index out of range');
    this.page = pages[index];
    await this.page.bringToFront();
    return { index, url: this.url() };
  }

  getConsoleMessages(limit = 50) {
    const state = getPageState(this.page);
    if (!state) return [];
    return state.console.slice(-limit);
  }

  getPageErrors(limit = 50) {
    const state = getPageState(this.page);
    if (!state) return [];
    return state.errors.slice(-limit);
  }

  getNetworkRequests(limit = 100) {
    const state = getPageState(this.page);
    if (!state) return [];
    return state.requests.slice(-limit);
  }

  getObservedBrowserState() {
    return getObservedBrowserStateForPage(this.page);
  }

  armDialog(opts = {}) {
    armObservedDialogResponseOnPage(this.page, opts);
  }

  async respondDialog(opts = {}) {
    return respondToObservedDialogOnPage(this.page, opts);
  }

  async title() {
    return this.page.title();
  }

  async textContent() {
    return this.page.locator('body').innerText();
  }

  async screenshot(opts) {
    return this.page.screenshot({ fullPage: false, type: 'png', ...opts });
  }

  async captureRegion(selector = '.content', opts = {}) {
    const { timeoutMs, ...shotRest } = opts;
    const run = async () => {
      if (this.screenshotHelper) {
        await this.screenshotHelper.apply(this.page);
        return this.screenshotHelper.capture(this.page, selector);
      }
      const shotOpts = {
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        scale: 'device',
        ...shotRest
      };
      return this.page.locator(selector).first().screenshot(shotOpts);
    };
    return this.withOpTimeout(run, {
      timeoutMs,
      label: 'captureRegion'
    });
  }

  async gotoAndCapture(url, options = {}) {
    // 整段重试：崩溃后 recreatePage 须重新 goto，不能只重截空白页
    return this.withPageCrashRetry(async () => {
      const {
        selector = '.content',
        timeoutMs,
        settleMs = 0,
        skipSsrfCheck = false,
        ssrfPolicy
      } = options;
      const waitUntil = normalizePlaywrightWaitUntil(options.waitUntil, 'load');
      if (this.screenshotHelper?.prepare) await this.screenshotHelper.prepare(this.page);
      await this.#gotoOnce(url, { waitUntil, timeoutMs, skipSsrfCheck, ssrfPolicy });
      const settle = clampInt(settleMs, 0, 60_000, 0);
      if (settle > 0) {
        const signal = AbortSignal.timeout(settle);
        await new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return this.captureRegion(selector, { timeoutMs: options.captureTimeoutMs });
    }, { label: 'gotoAndCapture' });
  }

  async regionText(selector = '.content') {
    const loc = this.page.locator(selector).first();
    if (await loc.count()) return loc.innerText();
    return this.textContent();
  }

  /**
   * @param {{ interactive?: boolean, compact?: boolean, maxDepth?: number, selector?: string, timeoutMs?: number }} [opts]
   */
  async roleSnapshot(opts = {}) {
    const timeout = clampSnapshotTimeoutMs(opts.timeoutMs);
    const selector = typeof opts.selector === 'string' ? opts.selector.trim() : '';
    const locator = selector ? this.page.locator(selector).first() : this.page.locator(':root');
    const ariaSnapshot = await locator.ariaSnapshot({ timeout });
    const built = buildRoleSnapshotFromAriaSnapshot(ariaSnapshot ?? '', {
      interactive: opts.interactive === true,
      compact: opts.compact !== false,
      maxDepth: opts.maxDepth
    });
    this.roleRefs = built.refs;
    storeRoleRefsOnPage(this.page, {
      refs: built.refs,
      mode: opts.refsMode === 'aria' ? 'aria' : 'role',
      frameSelector: opts.frameSelector
    });
    return {
      snapshot: built.snapshot,
      refs: built.refs,
      stats: getRoleSnapshotStats(built.snapshot, built.refs)
    };
  }

  /** @deprecated 使用 roleSnapshot；保留兼容旧 selectorHint 列表 */
  async interactiveSnapshot(opts = {}) {
    const maxNodes = Math.min(Math.max(opts.maxNodes ?? 80, 10), 200);
    const rootSelector = typeof opts.selector === 'string' && opts.selector.trim() ? opts.selector.trim() : 'body';
    return this.page.locator(rootSelector).first().evaluate((root, limit) => {
      const nodes = [];
      const seen = new Set();
      const walk = (el, depth) => {
        if (!el || nodes.length >= limit || depth > 12) return;
        if (el.nodeType !== 1) return;
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'svg'].includes(tag)) return;
        const role = el.getAttribute('role') || '';
        const interactive =
          ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag) ||
          ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab'].includes(role) ||
          el.hasAttribute('onclick') ||
          el.getAttribute('tabindex') === '0';
        if (interactive) {
          const text = (el.getAttribute('aria-label') || el.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          const name = el.getAttribute('name') || '';
          const type = el.getAttribute('type') || '';
          const href = tag === 'a' ? el.href : '';
          const id = el.id ? `#${el.id}` : '';
          const testId = el.getAttribute('data-testid');
          const selectorHint = id || (testId ? `[data-testid="${testId}"]` : '') || tag;
          const key = `${tag}:${selectorHint}:${text}`;
          if (!seen.has(key)) {
            seen.add(key);
            nodes.push({
              tag,
              role: role || undefined,
              text: text || undefined,
              name: name || undefined,
              type: type || undefined,
              href: href || undefined,
              selectorHint
            });
          }
        }
        for (const child of el.children) walk(child, depth + 1);
      };
      walk(root, 0);
      return nodes;
    }, maxNodes);
  }

  resolveTarget(target = {}) {
    return resolveInteractionTarget(target, this.page);
  }

  refLocator(ref) {
    return refLocator(this.page, ref);
  }

  async scrollIntoViewTarget(target, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs ?? 20_000);
    const { locator } = this.resolveTarget(target);
    await locator.scrollIntoViewIfNeeded({ timeout });
  }

  async fillFormFields(fields = [], opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const ssrfPolicy = opts.ssrfPolicy ?? {};
    for (const field of fields) {
      const ref = String(field.ref || '').trim();
      if (!ref) continue;
      const type = String(field.type || 'text').trim();
      const locator = refLocator(this.page, ref);
      const previousUrl = this.page.url();
      if (type === 'checkbox' || type === 'radio') {
        const checked =
          field.value === true || field.value === 1 || field.value === '1' || field.value === 'true';
        await locator.setChecked(checked, { timeout });
      } else {
        const value =
          typeof field.value === 'string' || typeof field.value === 'number'
            ? String(field.value)
            : '';
        await locator.fill(value, { timeout });
      }
      await this.guardAfterInteraction(previousUrl, ssrfPolicy);
    }
  }

  async clickTarget(target, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const previousUrl = this.page.url();
    const { locator } = this.resolveTarget(target);
    await locator.click({ timeout, force: opts.force === true });
    await this.guardAfterInteraction(previousUrl, opts.ssrfPolicy ?? {});
  }

  async typeTarget(target, text, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const previousUrl = this.page.url();
    const { locator } = this.resolveTarget(target);
    if (opts.clear !== false) await locator.fill('', { timeout });
    await locator.fill(String(text ?? ''), { timeout });
    if (opts.pressEnter) await locator.press('Enter', { timeout });
    await this.guardAfterInteraction(previousUrl, opts.ssrfPolicy ?? {});
  }

  async pressTarget(target, key, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const previousUrl = this.page.url();
    const { locator } = this.resolveTarget(target);
    await locator.press(String(key ?? 'Enter'), { timeout });
    await this.guardAfterInteraction(previousUrl, opts.ssrfPolicy ?? {});
  }

  async hoverTarget(target, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const { locator } = this.resolveTarget(target);
    await locator.hover({ timeout });
  }

  async selectTarget(target, values, opts = {}) {
    const timeout = clampInteractionTimeoutMs(opts.timeoutMs);
    const previousUrl = this.page.url();
    const { locator } = this.resolveTarget(target);
    const list = Array.isArray(values) ? values : [values];
    await locator.selectOption(list.map(String), { timeout });
    await this.guardAfterInteraction(previousUrl, opts.ssrfPolicy ?? {});
  }

  async clickSelector(selector, opts = {}) {
    return this.clickTarget({ selector }, opts);
  }

  async typeSelector(selector, text, opts = {}) {
    return this.typeTarget({ selector }, text, opts);
  }

  async waitFor(opts = {}) {
    const timeout = clampWaitTimeoutMs(opts.timeoutMs);
    if (typeof opts.timeMs === 'number' && opts.timeMs > 0) {
      await this.page.waitForTimeout(clampWaitTimeMs(opts.timeMs));
      return;
    }
    if (typeof opts.selector === 'string' && opts.selector.trim()) {
      const state = ['attached', 'detached', 'visible', 'hidden'].includes(opts.state)
        ? opts.state
        : 'visible';
      await this.page.locator(opts.selector.trim()).first().waitFor({ state, timeout });
      return;
    }
    if (typeof opts.ref === 'string' && parseRoleRef(opts.ref)) {
      const { locator } = this.resolveTarget({ ref: opts.ref });
      await locator.waitFor({ state: 'visible', timeout });
      return;
    }
    if (typeof opts.text === 'string' && opts.text.trim()) {
      await this.page.getByText(opts.text.trim()).first().waitFor({ state: 'visible', timeout });
      return;
    }
    if (typeof opts.textGone === 'string' && opts.textGone.trim()) {
      await this.page.getByText(opts.textGone.trim()).first().waitFor({ state: 'hidden', timeout });
      return;
    }
    if (typeof opts.url === 'string' && opts.url.trim()) {
      await this.page.waitForURL(opts.url.trim(), { timeout });
      return;
    }
    if (typeof opts.loadState === 'string') {
      await this.page.waitForLoadState(opts.loadState, { timeout });
    }
  }

  /**
   * @param {object} act
   */
  async runAct(act = {}, depth = 0) {
    const kind = String(act.kind || act.action || '').trim().toLowerCase();
    const ssrfPolicy = act.ssrfPolicy ?? {};
    const timeoutMs = act.timeoutMs;
    const dialogAbort = createObservedDialogAbortSignalForPage(this.page);
    try {
      if (dialogAbort.signal.aborted) throw dialogAbort.signal.reason;
      return await this._runActInner(act, kind, ssrfPolicy, timeoutMs, depth);
    } catch (err) {
      if (isBrowserObservedDialogBlockedError(err)) {
        return { blockedByDialog: true, browserState: err.browserState, url: this.url() };
      }
      throw err;
    } finally {
      dialogAbort.cleanup();
    }
  }

  async _runActInner(act, kind, ssrfPolicy, timeoutMs, depth) {
    if (depth > ACT_MAX_BATCH_DEPTH) {
      throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
    }

    switch (kind) {
      case 'batch': {
        const actions = Array.isArray(act.actions) ? act.actions : [];
        if (actions.length > ACT_MAX_BATCH_ACTIONS) {
          throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
        }
        const results = [];
        for (const step of actions) {
          try {
            await this._runActInner(
              { ...step, ssrfPolicy: step.ssrfPolicy ?? ssrfPolicy },
              String(step.kind || '').toLowerCase(),
              ssrfPolicy,
              step.timeoutMs,
              depth + 1
            );
            results.push({ ok: true });
          } catch (e) {
            results.push({ ok: false, error: e?.message || String(e) });
            if (act.stopOnError !== false) break;
          }
        }
        return { kind, url: this.url(), results };
      }
      case 'scrollintoview':
      case 'scroll_into_view':
        await this.scrollIntoViewTarget(
          { ref: act.ref, selector: act.selector },
          { timeoutMs }
        );
        return { kind, url: this.url() };
      case 'click':
        await this.clickTarget(
          { ref: act.ref, selector: act.selector },
          { timeoutMs, force: act.force, ssrfPolicy }
        );
        return { kind, url: this.url() };
      case 'type':
      case 'fill':
        if (Array.isArray(act.fields)) {
          await this.fillFormFields(act.fields, { timeoutMs, ssrfPolicy });
          return { kind, url: this.url() };
        }
        await this.typeTarget(
          { ref: act.ref, selector: act.selector },
          act.text ?? act.value ?? '',
          { timeoutMs, clear: act.clear !== false, pressEnter: act.pressEnter === true, ssrfPolicy }
        );
        return { kind, url: this.url() };
      case 'press':
        await this.pressTarget(
          { ref: act.ref, selector: act.selector },
          act.key ?? 'Enter',
          { timeoutMs, ssrfPolicy }
        );
        return { kind, url: this.url() };
      case 'hover':
        await this.hoverTarget({ ref: act.ref, selector: act.selector }, { timeoutMs });
        return { kind, url: this.url() };
      case 'select':
        await this.selectTarget(
          { ref: act.ref, selector: act.selector },
          act.values ?? act.value,
          { timeoutMs, ssrfPolicy }
        );
        return { kind, url: this.url() };
      case 'wait':
        await this.waitFor({
          timeMs: act.timeMs,
          selector: act.selector,
          ref: act.ref,
          state: act.state,
          loadState: act.loadState,
          text: act.text,
          textGone: act.textGone,
          url: act.url,
          timeoutMs
        });
        return { kind, url: this.url() };
      case 'evaluate':
        return {
          kind,
          url: this.url(),
          result: await this.evaluateExpression(act.expression ?? act.fn, act.ref)
        };
      default:
        throw new Error(`Unsupported act kind: ${kind || '(empty)'}`);
    }
  }

  /**
   * 在页面上下文执行表达式（返回 JSON 可序列化结果）。
   * @param {string} expression
   */
  async evaluateExpression(expression, ref) {
    const src = String(expression ?? '').trim();
    if (!src) throw new Error('expression 不能为空');
    if (src.length > 8000) throw new Error('expression 过长');
    const fnBody =
      src.startsWith('(') || src.startsWith('function') || src.startsWith('async') ? src : `() => (${src})`;
    if (ref) {
      const locator = refLocator(this.page, ref);
      return locator.evaluate((el, body) => {
        // eslint-disable-next-line no-eval
        const fn = eval(`(${body})`);
        if (typeof fn !== 'function') throw new Error('expression 须为函数体');
        return fn(el);
      }, fnBody);
    }
    return this.page.evaluate((fnBody) => {
      // eslint-disable-next-line no-eval
      const fn = eval(`(${fnBody})`);
      if (typeof fn !== 'function') throw new Error('expression 须为函数体，如 () => document.title');
      return fn();
    }, src.startsWith('(') || src.startsWith('function') || src.startsWith('async') ? src : `() => (${src})`);
  }

  /** @template T */
  static async using(options, fn, usingOpts = {}) {
    const crashRetries = Math.max(
      0,
      Math.min(3, Math.floor(Number(usingOpts.crashRetries ?? DEFAULT_USING_CRASH_RETRIES)))
    );
    /** @type {unknown} */
    let lastErr;
    for (let attempt = 0; attempt <= crashRetries; attempt++) {
      const session = await PlaywrightAgentSession.launch(options);
      try {
        return await fn(session);
      } catch (err) {
        lastErr = err;
        const canRetry = isPlaywrightCrashError(err) && attempt < crashRetries;
        if (!canRetry) throw err;
        RuntimeUtil.makeLog(
          'warn',
          `Playwright using 目标崩溃，换新浏览器重试 (${attempt + 1}/${crashRetries})：${normalizeError(err).message}`,
          'PlaywrightSession'
        );
      } finally {
        await session.close();
      }
    }
    throw lastErr;
  }

  url() {
    return this.page?.url() ?? '';
  }

  async close() {
    await softClosePlaywrightTree(
      { page: this.page, context: this.context, browser: this.browser },
      this.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
    );
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
