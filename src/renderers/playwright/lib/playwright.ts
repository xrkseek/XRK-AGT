import BrowserRendererBase, {
  type BrowserLike,
  type BrowserRendererConfig,
  type ScreenshotData,
} from "#infrastructure/renderer/browser-renderer-base.js";
import playwright from "playwright";
import { createRequire } from "node:module";
import RuntimeUtil from '#utils/runtime-util.js';
import Renderer, { type RendererMeta } from "#infrastructure/renderer/Renderer.js";
import { connectPlaywrightBrowser, launchPlaywrightBrowser } from "#utils/playwright-puppeteer-compat.js";
import { normalizeError } from "#utils/normalize-error.js";

export type { BrowserLike, BrowserRendererConfig, ScreenshotData, RendererMeta };

const { buildPlaywrightLaunchOptions, pickBrowserPath } = createRequire(import.meta.url)('#utils/system-browser.cjs') as {
  buildPlaywrightLaunchOptions: (opts?: {
    headless?: boolean;
    args?: string[];
    channel?: unknown;
    configuredPath?: unknown;
  }) => LaunchOptions;
  pickBrowserPath: (value: unknown) => string | null;
};

type LaunchOptions = {
  headless: boolean;
  args: string[];
  channel?: string;
  executablePath?: string;
};

/** Narrow surface for connect/launch helpers (cast via unknown, never untyped). */
type PlaywrightCompatApi = Parameters<typeof connectPlaywrightBrowser>[0];

type BoundingBox = { x: number; y: number; width: number; height: number };

type PwLocator = {
  first: () => PwLocator;
  boundingBox: () => Promise<BoundingBox>;
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer | Uint8Array>;
};

type PwPage = {
  setDefaultTimeout: (ms: number) => void;
  setDefaultNavigationTimeout: (ms: number) => void;
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  evaluate: {
    (pageFunction: () => unknown | Promise<unknown>): Promise<unknown>;
    <Arg>(pageFunction: (arg: Arg) => unknown | Promise<unknown>, arg: Arg): Promise<unknown>;
  };
  locator: (selector: string) => PwLocator;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  screenshot: (opts?: Record<string, unknown>) => Promise<Buffer | Uint8Array>;
  waitForTimeout: (ms: number) => Promise<void>;
  close: (opts?: { runBeforeUnload?: boolean }) => Promise<void>;
};

type PwContext = {
  newPage: () => Promise<PwPage>;
  close: () => Promise<void>;
};

type ViewportLike = {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
};

/**
 * Playwright-based browser renderer for screenshot generation.
 * 配置由 RendererLoader 通过 getRendererConfig('playwright') 注入。
 */
export default class PlaywrightRenderer extends BrowserRendererBase {
  browserType = "chromium";
  playwrightTimeout = 120000;
  healthCheckInterval = 120000;
  maxRetries = 3;
  retryDelay = 2000;
  launchOptions: LaunchOptions = { headless: true, args: [] };
  wsEndpoint: string | null = null;
  contextOptions: Record<string, unknown> = {};

  constructor(config: BrowserRendererConfig & Record<string, unknown> = {}) {
    super({ id: "playwright", type: "image", render: "screenshot" }, config, "PlaywrightRenderer");

    this.browserType = String(config.browserType ?? config.browser ?? "chromium");
    this.playwrightTimeout = (config.playwrightTimeout as number | undefined) ?? 120000;
    this.healthCheckInterval = (config.healthCheckInterval as number | undefined) ?? 120000;
    this.maxRetries = (config.maxRetries as number | undefined) ?? 3;
    this.retryDelay = (config.retryDelay as number | undefined) ?? 2000;

    const defaultArgs = [
      "--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage",
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-extensions",
      "--disable-background-networking", "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows", "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection", "--disable-renderer-backgrounding",
      "--force-color-profile=srgb", "--metrics-recording-only", "--mute-audio",
      "--no-first-run", "--enable-automation", "--password-store=basic",
      "--use-mock-keychain", "--disable-blink-features=AutomationControlled",
      "--js-flags=--max-old-space-size=512", "--disable-accelerated-2d-canvas",
      "--disable-accelerated-jpeg-decoding", "--disable-accelerated-mjpeg-decode",
      "--disable-accelerated-video-decode",
    ];
    this.launchOptions = buildPlaywrightLaunchOptions({
      headless: (config.headless as boolean | undefined) ?? true,
      args: (config.args as string[] | undefined) ?? defaultArgs,
      channel: config.channel,
      configuredPath: config.chromiumPath
    });
    this.wsEndpoint = pickBrowserPath(config.wsEndpoint ?? config.playwrightWS);

    const vp = (config.viewport ??
      (config.contextOptions as { viewport?: ViewportLike } | undefined)?.viewport ??
      {}) as ViewportLike;
    this.contextOptions = (config.contextOptions as Record<string, unknown> | undefined) ?? {
      viewport: { width: vp.width ?? 1280, height: vp.height ?? 720 },
      deviceScaleFactor: vp.deviceScaleFactor ?? 2,
      bypassCSP: true,
      reducedMotion: "reduce",
    };
  }

  async connectToExisting(wsEndpoint: string, retries = 0): Promise<BrowserLike | null> {
    const delay = this.retryDelay * Math.pow(2, retries);
    let browser: BrowserLike | null = null;
    try {
      RuntimeUtil.makeLog("info", `Connecting to existing ${this.browserType} instance (attempt ${retries + 1}/${this.maxRetries})`, this.logTag);

      browser = (await connectPlaywrightBrowser(
        playwright as unknown as PlaywrightCompatApi,
        this.browserType,
        wsEndpoint,
        { timeout: 10000 },
      )) as BrowserLike | null;
      const pwBrowser = browser as unknown as { newContext: () => Promise<PwContext> };
      const context = await pwBrowser.newContext();
      const page = await context.newPage();
      await page.goto("about:blank", { timeout: 5000 });
      await page.close();
      await context.close();

      RuntimeUtil.makeLog("info", `Successfully connected to existing ${this.browserType} instance`, this.logTag);
      return browser;
    } catch (e: unknown) {
      RuntimeUtil.makeLog("warn", `Connection failed: ${normalizeError(e).message}`, this.logTag);
      if (browser) await this.safeCloseBrowser(browser, 3000);

      if (retries < this.maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
        return this.connectToExisting(wsEndpoint, retries + 1);
      }

      await this.removeStoredEndpoint();
      return null;
    }
  }

  async browserInit() {
    if (this.browser) {
      const ok = await this.ensureBrowserHealthy(async (b: BrowserLike) => {
        if (typeof b.isConnected === "function" && !b.isConnected()) {
          throw new Error("disconnected");
        }
        b.contexts!();
      });
      if (ok) return this.browser;
    }

    const lockResult = await this.waitForInitLock();
    if (lockResult !== true && lockResult !== false) return lockResult;
    if (lockResult === false) return false;

    this.lock = true;
    try {
      RuntimeUtil.makeLog("info", `Starting playwright ${this.browserType}...`, this.logTag);

      await this.ensureMac(`AGT:${this.browserType}:browserURL`);
      const wsEndpoint = this.wsEndpoint || await this.resolveWsEndpoint();

      if (wsEndpoint) {
        this.browser = await this.connectToExisting(wsEndpoint);
      }

      if (!this.browser) {
        RuntimeUtil.makeLog("info", `Launching new ${this.browserType} instance...`, this.logTag);
        this.browser = (await this.withTimeout(
          launchPlaywrightBrowser(
            playwright as unknown as PlaywrightCompatApi,
            this.browserType,
            this.launchOptions,
          ),
          this.playwrightTimeout,
          "browser launch"
        )) as BrowserLike | null;

        if (this.browser) {
          RuntimeUtil.makeLog("info", `Playwright ${this.browserType} started successfully`, this.logTag);
          if (typeof this.browser.wsEndpoint === 'function') {
            const endpoint = this.browser.wsEndpoint();
            if (endpoint) await this.persistWsEndpoint(endpoint);
          }
        }
      }

      if (!this.browser) {
        RuntimeUtil.makeLog("error", `Playwright ${this.browserType} failed to start`, this.logTag);
        return false;
      }

      this.browser.on!("disconnected", () => {
        RuntimeUtil.makeLog("warn", `${this.browserType} instance disconnected`, this.logTag);
        this.browser = null;
        void this.removeStoredEndpoint();
        void this.restart(true);
      });

      this.startHealthCheck();
    } catch (e: unknown) {
      const msg = normalizeError(e).message;
      if (/Executable doesn't exist/i.test(msg)) {
        RuntimeUtil.makeLog("error", "Playwright 浏览器未安装，请在启动菜单选择「Playwright 浏览器」安装，或执行: pnpm run setup:browsers", this.logTag);
      } else if (!this.launchOptions.executablePath) {
        RuntimeUtil.makeLog("error", "未找到可用浏览器：请安装系统 Chrome/Chromium，或在启动菜单安装 Playwright Chromium", this.logTag);
      }
      RuntimeUtil.makeLog("error", `Browser initialization failed: ${msg}`, this.logTag);
      this.browser = null;
    } finally {
      this.lock = false;
    }

    return this.browser;
  }

  startHealthCheck() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (!this.browser || this.activeSlotCount() > 0 || this._restarting) return;

      try {
        if (typeof this.browser.isConnected === "function" && !this.browser.isConnected()) {
          throw new Error("disconnected");
        }
        await this.withTimeout(Promise.resolve(this.browser.contexts!()), this.browserOpTimeoutMs, "health check");
      } catch (e: unknown) {
        RuntimeUtil.makeLog("warn", `Health check failed: ${normalizeError(e).message}, restarting...`, this.logTag);
        await this.restart(true);
      }
    }, this.healthCheckInterval);
  }

  async screenshot(name: string, data: ScreenshotData | Record<string, unknown> = {}) {
    const shotData: ScreenshotData =
      typeof (data as { tplFile?: unknown }).tplFile === "string"
        ? (data as ScreenshotData)
        : { ...data, tplFile: "" };

    const slot = await this.acquireScreenshotSlot(name, shotData, this.playwrightTimeout);
    if (!slot) return false;

    try {
      if (!await this.browserInit()) return false;

      const prepared = this.prepareScreenshotFile(name, shotData);
      if (!prepared) return false;

      const { filePath, pageHeight } = prepared;
      let ret: Array<Buffer | Uint8Array> = [];
      let context: PwContext | null = null;
      let page: PwPage | null = null;
      const start = Date.now();

      try {
        const sysScale = Number(shotData.sys?.scale);
        const contextOptions = { ...this.contextOptions };
        if (Number.isFinite(sysScale) && sysScale > 0) {
          contextOptions.deviceScaleFactor = Math.min(Math.max(sysScale, 1), 4);
        }
        const browser = this.browser as unknown as {
          newContext: (opts?: unknown) => Promise<PwContext>;
        };
        const nextContext = await this.withTimeout(
          browser.newContext(contextOptions),
          this.browserOpTimeoutMs,
          "newContext"
        );
        context = nextContext;
        page = await this.withTimeout(nextContext.newPage(), this.browserOpTimeoutMs, "newPage");
        if (!page) throw new Error("Failed to create page");
        page.setDefaultTimeout(this.playwrightTimeout);
        page.setDefaultNavigationTimeout(this.playwrightTimeout);

        const gotoOpts = { timeout: this.playwrightTimeout, waitUntil: "load", ...shotData.pageGotoParams };
        await page.goto(Renderer.toFileUrl(filePath), gotoOpts);
        await page.evaluate(() => new Promise(r => setTimeout(r, 400)));

        const body = (await page.locator("#container").first()) || (await page.locator("body"));
        if (!body) throw new Error("Content element not found");

        const boundingBox = await body.boundingBox();
        const screenshotOptions: Record<string, unknown> = {
          ...this.buildScreenshotOptions(shotData),
          fullPage: !shotData.multiPage,
        };

        let num = 1;
        if (shotData.multiPage) {
          screenshotOptions.type = "jpeg";
          screenshotOptions.fullPage = false;
          num = Math.ceil(boundingBox.height / pageHeight) || 1;
        }

        if (!shotData.multiPage) {
          const buff = await body.screenshot(screenshotOptions);
          this.renderNum++;
          const kb = (buff.length / 1024).toFixed(2) + "KB";
          RuntimeUtil.makeLog("info", `[${name}][${this.renderNum}] ${kb} ${Date.now() - start}ms`, this.logTag);
          ret.push(buff);
        } else {
          if (num > 1) {
            await page.setViewportSize({
              width: Math.ceil(boundingBox.width),
              height: Math.min(pageHeight + 100, 2000),
            });
          }

          for (let i = 1; i <= num; i++) {
            if (i !== 1 && i === num) {
              const remainingHeight = Math.min(parseInt(boundingBox.height as unknown as string) - pageHeight * (num - 1), 2000);
              await page.setViewportSize({
                width: Math.ceil(boundingBox.width),
                height: remainingHeight > 0 ? remainingHeight : 100,
              });
            }

            if (i !== 1) {
              await page.evaluate(
                (scrollY: number) => {
                  (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, scrollY);
                },
                pageHeight * (i - 1),
              );
              await page.waitForTimeout(100);
            }

            const clip = (i === num && num > 1) ? {
              x: boundingBox.x,
              y: 0,
              width: boundingBox.width,
              height: Math.min(boundingBox.height - pageHeight * (i - 1), pageHeight),
            } : null;

            const buff = clip
              ? await page.screenshot({ ...screenshotOptions, clip })
              : await body.screenshot(screenshotOptions);

            this.renderNum++;
            const kb = (buff.length / 1024).toFixed(2) + "KB";
            RuntimeUtil.makeLog("debug", `[${name}][${i}/${num}] ${kb}`, this.logTag);
            ret.push(buff);

            if (i < num && num > 2) {
              await page.waitForTimeout(100);
            }
          }

          if (num > 1) {
            RuntimeUtil.makeLog("info", `[${name}] Completed in ${Date.now() - start}ms`, this.logTag);
          }
        }
      } catch (error: unknown) {
        RuntimeUtil.makeLog("error", `[${name}] Screenshot failed: ${normalizeError(error).message}`, this.logTag);
        this.handleFatalScreenshotError(error);
        ret = [];
      } finally {
        if (page) {
          try {
            await page.close({ runBeforeUnload: false });
          } catch {}
        }
        if (context) {
          try {
            await context.close();
          } catch {}
        }
      }

      return this.finishScreenshotRun(name, ret, shotData);
    } finally {
      this.releaseScreenshotSlot(slot.slotId, slot.userPriority);
    }
  }

  async cleanup() {
    const browser = this.detachBrowser();
    await this.safeCloseBrowser(browser);
    await this.removeStoredEndpoint();
    RuntimeUtil.makeLog("info", "Playwright resources cleaned up", this.logTag);
  }
}
