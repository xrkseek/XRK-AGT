/**
 * Playwright 浏览器启动 + Puppeteer API 兼容（setViewport 等）
 * 仅 Playwright 路径使用；Puppeteer 渲染器走原生 API，勿调用本模块。
 */

type CompatFlag = { __xrkPuppeteerCompat?: boolean };

type PageLike = CompatFlag & {
  setViewport?: (viewport?: Record<string, unknown>) => unknown;
  setViewportSize?: (viewport?: Record<string, unknown>) => unknown;
};

type ContextLike = CompatFlag & {
  newPage: (...args: unknown[]) => Promise<PageLike>;
};

type BrowserLike = CompatFlag & {
  newContext: (...args: unknown[]) => Promise<ContextLike>;
};

type PlaywrightLauncher = {
  launch: (options?: unknown) => Promise<BrowserLike>;
  connect: (wsEndpoint: string, options?: unknown) => Promise<BrowserLike>;
};

type PlaywrightLike = Record<string, PlaywrightLauncher>;

function applyPuppeteerPageCompat(page: PageLike | null | undefined): PageLike | null | undefined {
  if (!page || page.__xrkPuppeteerCompat) return page;
  page.__xrkPuppeteerCompat = true;
  if (typeof page.setViewport !== 'function' && typeof page.setViewportSize === 'function') {
    page.setViewport = (viewport = {}) => page.setViewportSize!(viewport);
  }
  return page;
}

function patchBrowserContextCompat(context: ContextLike | null | undefined): ContextLike | null | undefined {
  if (!context || context.__xrkPuppeteerCompat) return context;
  context.__xrkPuppeteerCompat = true;
  const origNewPage = context.newPage.bind(context);
  context.newPage = async (...args: unknown[]) =>
    applyPuppeteerPageCompat(await origNewPage(...args)) as PageLike;
  return context;
}

function patchBrowserCompat(browser: BrowserLike | null | undefined): BrowserLike | null | undefined {
  if (!browser || browser.__xrkPuppeteerCompat) return browser;
  browser.__xrkPuppeteerCompat = true;
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args: unknown[]) =>
    patchBrowserContextCompat(await origNewContext(...args)) as ContextLike;
  return browser;
}

export async function launchPlaywrightBrowser(
  pw: PlaywrightLike,
  type: string,
  options: unknown,
): Promise<BrowserLike | null | undefined> {
  return patchBrowserCompat(await pw[type]!.launch(options));
}

export async function connectPlaywrightBrowser(
  pw: PlaywrightLike,
  type: string,
  wsEndpoint: string,
  options: unknown = {},
): Promise<BrowserLike | null | undefined> {
  return patchBrowserCompat(await pw[type]!.connect(wsEndpoint, options));
}
