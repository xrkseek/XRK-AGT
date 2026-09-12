import BrowserRendererBase, {
  type BrowserLike,
  type BrowserRendererConfig,
  type ScreenshotData,
} from "#infrastructure/renderer/browser-renderer-base.js";
import puppeteer from "puppeteer";
import { createRequire } from "node:module";
import RuntimeUtil from "#utils/runtime-util.js";
import { normalizeError } from "#utils/normalize-error.js";
import Renderer from "#infrastructure/renderer/Renderer.js";

const { resolvePlaywrightExecutable, pickBrowserPath } = createRequire(import.meta.url)(
  "#utils/system-browser.cjs",
) as {
  resolvePlaywrightExecutable: (chromiumPath?: unknown) => string | undefined | null;
  pickBrowserPath: (endpoint?: unknown) => string | undefined;
};

type ViewportSize = {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
};

type PuppeteerElementHandle = {
  boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  screenshot: (options?: Record<string, unknown>) => Promise<Buffer | Uint8Array | string>;
};

type PuppeteerPageLike = {
  setDefaultTimeout: (timeout: number) => void;
  setDefaultNavigationTimeout: (timeout: number) => void;
  setViewport: (viewport: ViewportSize) => Promise<void>;
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  evaluate: {
    (pageFunction: () => unknown): Promise<unknown>;
    <Arg>(pageFunction: (arg: Arg) => unknown, arg: Arg): Promise<unknown>;
  };
  $: (selector: string) => Promise<PuppeteerElementHandle | null>;
  screenshot: (options?: Record<string, unknown>) => Promise<Buffer | Uint8Array | string>;
  close: () => Promise<unknown>;
};

/**
 * Puppeteer-based browser renderer for screenshot generation.
 * 配置由 RendererLoader 通过 getRendererConfig('puppeteer') 注入。
 */
export default class PuppeteerRenderer extends BrowserRendererBase {
  puppeteerTimeout = 120000;
  healthCheckInterval = 120000;
  maxRetries = 3;
  retryDelay = 2000;
  viewport: { width: number; height: number; deviceScaleFactor: number } = {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
  };

  constructor(config: BrowserRendererConfig = {}) {
    super({ id: "puppeteer", type: "image", render: "screenshot" }, config, "PuppeteerRenderer");

    this.puppeteerTimeout = (config.puppeteerTimeout as number | undefined) ?? 120000;
    this.healthCheckInterval = (config.healthCheckInterval as number | undefined) ?? 120000;
    this.maxRetries = (config.maxRetries as number | undefined) ?? 3;
    this.retryDelay = (config.retryDelay as number | undefined) ?? 2000;

    const vp: ViewportSize = (config.viewport as ViewportSize | undefined) ?? {};
    this.viewport = {
      width: vp.width ?? 1280,
      height: vp.height ?? 720,
      deviceScaleFactor: vp.deviceScaleFactor ?? 2,
    };
    this.config = {
      headless: (config.headless as boolean | string | undefined) ?? "new",
      args: (config.args as string[] | undefined) ?? ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'],
      wsEndpoint: pickBrowserPath(config.wsEndpoint ?? config.puppeteerWS),
      protocolTimeout: (config.protocolTimeout as number | undefined) ?? this.puppeteerTimeout,
      timeout: (config.launchTimeout as number | undefined) ?? this.puppeteerTimeout,
    };
    const executablePath = resolvePlaywrightExecutable(config.chromiumPath);
    if (executablePath) this.config.executablePath = executablePath;
  }

  async connectToExisting(browserWSEndpoint: string, retries = 0): Promise<BrowserLike | null> {
    let browser: BrowserLike | null = null;
    try {
      browser = (await puppeteer.connect({
        browserWSEndpoint,
        defaultViewport: null,
        protocolTimeout: this.config.protocolTimeout as number | undefined,
      })) as unknown as BrowserLike;
      const page = (await browser.newPage!()) as PuppeteerPageLike;
      page.setDefaultTimeout(5000);
      await page.goto("about:blank", { timeout: 5000, waitUntil: "domcontentloaded" });
      await page.close().catch(() => {});
      return browser;
    } catch (e: unknown) {
      if (browser) await this.safeCloseBrowser(browser, 3000);
      if (retries < this.maxRetries - 1) {
        await new Promise((r) => setTimeout(r, this.retryDelay * Math.pow(2, retries)));
        return this.connectToExisting(browserWSEndpoint, retries + 1);
      }
      RuntimeUtil.makeLog("warn", `Failed to connect to existing Chromium: ${normalizeError(e).message}`, this.logTag);
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
        await b.version!();
      });
      if (ok) return this.browser;
    }

    const lockResult = await this.waitForInitLock();
    if (lockResult !== true && lockResult !== false) return lockResult;
    if (lockResult === false) return false;

    this.lock = true;
    try {
      RuntimeUtil.makeLog("info", "Starting puppeteer Chromium...", this.logTag);

      await this.ensureMac("AGT:chromium:browserWSEndpoint");
      const browserWSEndpoint = await this.resolveWsEndpoint();

      if (browserWSEndpoint) {
        RuntimeUtil.makeLog("info", `Connecting to existing Chromium instance: ${browserWSEndpoint}`, this.logTag);
        this.browser = await this.connectToExisting(browserWSEndpoint);
        if (this.browser) {
          RuntimeUtil.makeLog("info", "Successfully connected to existing Chromium instance", this.logTag);
        }
      }

      if (!this.browser) {
        this.browser = (await this.withTimeout(
          puppeteer.launch(
            this.buildBrowserLaunchOptions() as unknown as Parameters<typeof puppeteer.launch>[0],
          ),
          this.puppeteerTimeout,
          "browser launch"
        ).catch((err: unknown) => {
          const message = normalizeError(err).message;
          RuntimeUtil.makeLog("error", `Failed to start Chromium: ${message}`, this.logTag);

          if (
            message.includes("Could not find Chromium") ||
            /Executable doesn't exist|Failed to launch/i.test(message)
          ) {
            RuntimeUtil.makeLog(
              "error",
              "未找到 Chromium：请安装系统 Chrome/Edge，或配置 chromiumPath / PUPPETEER_EXECUTABLE_PATH",
              this.logTag
            );
          } else if (message.includes("cannot open shared object file")) {
            RuntimeUtil.makeLog("error", "Chromium runtime libraries not installed", this.logTag);
          }
          return null;
        })) as unknown as BrowserLike | null;

        if (this.browser) {
          RuntimeUtil.makeLog("info", `Puppeteer Chromium started successfully: ${this.browser.wsEndpoint!()}`, this.logTag);
          await this.persistWsEndpoint(this.browser.wsEndpoint!());
        }
      }

      if (!this.browser) {
        RuntimeUtil.makeLog("error", "Puppeteer Chromium failed to start", this.logTag);
        return false;
      }

      this.browser.on!("disconnected", () => {
        RuntimeUtil.makeLog("warn", "Chromium instance disconnected, restarting...", this.logTag);
        this.browser = null;
        void this.restart(true);
      });

      this.startHealthCheck();
    } catch (e: unknown) {
      RuntimeUtil.makeLog("error", `Browser initialization failed: ${normalizeError(e).message}`, this.logTag);
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
        await this.withTimeout(Promise.resolve(this.browser.version!()), this.browserOpTimeoutMs, "health check");
      } catch (e: unknown) {
        RuntimeUtil.makeLog("warn", `Health check failed: ${normalizeError(e).message}, restarting...`, this.logTag);
        await this.restart(true);
      }
    }, this.healthCheckInterval);
  }

  async screenshot(name: string, data: ScreenshotData | Record<string, unknown> = {}) {
    const shotData = data as ScreenshotData;
    const slot = await this.acquireScreenshotSlot(name, shotData, this.puppeteerTimeout);
    if (!slot) return false;

    try {
      if (!await this.browserInit()) return false;

      const prepared = this.prepareScreenshotFile(name, shotData);
      if (!prepared) return false;

      const { filePath, pageHeight } = prepared;
      let ret: Buffer[] = [];
      let page: PuppeteerPageLike | null = null;
      const start = Date.now();

      try {
        page = await this.withTimeout(
          this.browser!.newPage!() as Promise<PuppeteerPageLike>,
          this.browserOpTimeoutMs,
          "newPage",
        );
        if (!page) throw new Error("Failed to create page");

        page.setDefaultTimeout(this.puppeteerTimeout);
        page.setDefaultNavigationTimeout(this.puppeteerTimeout);

        const sysScale = Number(shotData.sys?.scale);
        const viewport = { ...this.viewport };
        if (Number.isFinite(sysScale) && sysScale > 0) {
          viewport.deviceScaleFactor = Math.min(Math.max(sysScale, 1), 4);
        }
        await page.setViewport(viewport);

        const gotoOpts = { timeout: this.puppeteerTimeout, waitUntil: "load", ...shotData.pageGotoParams };
        await page.goto(Renderer.toFileUrl(filePath), gotoOpts);
        await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

        const body = (await page.$("#container")) || (await page.$("body"));
        if (!body) throw new Error("Content element not found");

        const boundingBox = await body.boundingBox();
        const screenshotOptions = this.buildScreenshotOptions(shotData);

        let num = 1;
        if (shotData.multiPage) {
          screenshotOptions.type = "jpeg";
          num = Math.ceil(boundingBox!.height / pageHeight) || 1;
        }

        if (!shotData.multiPage) {
          const buff = await body.screenshot(screenshotOptions);
          const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff);
          this.renderNum++;
          const kb = (buffer.length / 1024).toFixed(2) + "KB";
          RuntimeUtil.makeLog("info", `[${name}][${this.renderNum}] ${kb} ${Date.now() - start}ms`, this.logTag);
          ret.push(buffer);
        } else {
          if (num > 1) {
            await page.setViewport({
              width: Math.ceil(boundingBox!.width),
              height: Math.min(pageHeight + 100, 2000),
            });
          }

          for (let i = 1; i <= num; i++) {
            if (i !== 1 && i === num) {
              const remainingHeight = Math.min(parseInt(String(boundingBox!.height)) - pageHeight * (num - 1), 2000);
              await page.setViewport({
                width: Math.ceil(boundingBox!.width),
                height: remainingHeight > 0 ? remainingHeight : 100,
              });
            }

            if (i !== 1) {
              await page.evaluate(
                (scrollY: number) =>
                  (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, scrollY),
                pageHeight * (i - 1),
              );
              await new Promise((resolve) => setTimeout(resolve, 100));
            }

            const buff = num === 1
              ? await body.screenshot(screenshotOptions)
              : await page.screenshot(screenshotOptions);
            const buffer = Buffer.isBuffer(buff) ? buff : Buffer.from(buff);
            this.renderNum++;
            const kb = (buffer.length / 1024).toFixed(2) + "KB";
            RuntimeUtil.makeLog("debug", `[${name}][${i}/${num}] ${kb}`, this.logTag);
            ret.push(buffer);

            if (i < num && num > 2) {
              await new Promise((resolve) => setTimeout(resolve, 100));
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
        if (page) await page.close().catch(() => {});
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
    RuntimeUtil.makeLog("info", "Puppeteer resources cleaned up", this.logTag);
  }
}
