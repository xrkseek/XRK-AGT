/**
 * crawl 运行时配置 — 单一来源：ai-workflow.crawl + renderer.playwright + overrides
 * 优先级：调用方 overrides > ai-workflow.yaml > renderer.playwright > 默认值
 */
import runtimeConfig from '#infrastructure/config/config.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { createRequire } from 'node:module';

const { findSystemBrowser } = createRequire(import.meta.url)('#utils/system-browser.cjs');

const BROWSER_TYPES = new Set(['chromium', 'firefox', 'webkit']);
const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
const FETCH_MAX_RESPONSE_BYTES_MIN = 32_000;
const FETCH_MAX_RESPONSE_BYTES_MAX = 10_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_FETCH_TIMEOUT_SECONDS = 30;
const DEFAULT_FETCH_CACHE_TTL_MINUTES = 15;
const DEFAULT_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const DEFAULT_SEARCH_TIMEOUT_SECONDS = 20;
const DEFAULT_SEARCH_CACHE_TTL_MINUTES = 15;

const SEARCH_PROVIDER_IDS = [
  'brave',
  'perplexity',
  'exa',
  'tavily',
  'parallel',
  'parallelFree',
  'gemini',
  'kimi',
  'minimax',
  'firecrawl',
  'searxng',
  'ollama'
];

function trimString(value: any) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function pickString(...candidates: any) {
  for (const c of candidates) {
    const s = trimString(c);
    if (s) return s;
  }
  return '';
}

function pickBool(fallback: any, ...candidates: any) {
  for (const c of candidates) {
    if (typeof c === 'boolean') return c;
  }
  return fallback;
}

function pickNumber(fallback: any, { min, max }: any = {}, ...candidates: any[]) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      let v = Math.floor(c);
      if (min != null) v = Math.max(min, v);
      if (max != null) v = Math.min(max, v);
      return v;
    }
    if (typeof c === 'string' && c.trim()) {
      const n = Number(c);
      if (Number.isFinite(n)) {
        let v = Math.floor(n);
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
        return v;
      }
    }
  }
  return fallback;
}

function pickStringArray(fallback: any, ...candidates: any) {
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      const out = c.map((s: any) => String(s ?? '').trim()).filter(Boolean);
      if (out.length) return out;
    }
  }
  return fallback;
}

function mergeSection(sectionSlice: any, overrideSlice: any) {
  return {
    ...(sectionSlice && typeof sectionSlice === 'object' ? sectionSlice : {}),
    ...(overrideSlice && typeof overrideSlice === 'object' ? overrideSlice : {})
  };
}

function mergeAllProviderSections(section: any, overrides: any) {
  const out: Record<string, any> = {};
  for (const id of SEARCH_PROVIDER_IDS) {
    out[id] = mergeSection(section?.[id], overrides?.[id]);
  }
  return out;
}

/** YAML 段名（camelCase）与 provider id（可含连字符）对齐 */
export function getWebSearchProviderScope(runtime: any, providerId: any) {
  const id = String(providerId || '').toLowerCase();
  if (!runtime || typeof runtime !== 'object') return undefined;
  if (id === 'parallel-free') {
    return runtime.parallelFree ?? runtime['parallel-free'];
  }
  return runtime[id];
}

function attachProviderScopeAliases(config: any) {
  if (config.parallelFree && !config['parallel-free']) {
    config['parallel-free'] = config.parallelFree;
  }
  return config;
}

export function getCrawlConfigSection() {
  return getAiWorkflowConfigOptional().crawl ?? {};
}

export function getPlaywrightRendererConfig() {
  try {
    return runtimeConfig.getRendererConfig?.('playwright') ?? {};
  } catch {
    return {};
  }
}

/** @param {object} [overrides] */
export function resolveWebFetchRuntime(overrides: any = {}) {
  const section = getCrawlConfigSection().webFetch ?? {};

  const maxCharsCap = pickNumber(
    DEFAULT_FETCH_MAX_CHARS,
    { min: 100 },
    overrides.maxCharsCap,
    section.maxChars
  );

  const maxResponseBytes = pickNumber(
    DEFAULT_FETCH_MAX_RESPONSE_BYTES,
    { min: FETCH_MAX_RESPONSE_BYTES_MIN, max: FETCH_MAX_RESPONSE_BYTES_MAX },
    overrides.maxResponseBytes,
    section.maxResponseBytes
  );

  const apiKey =
    overrides.firecrawlApiKey || trimString(section.firecrawlApiKey) || undefined;

  const timeoutSeconds = pickNumber(
    DEFAULT_FETCH_TIMEOUT_SECONDS,
    { min: 1 },
    overrides.timeoutSeconds,
    section.timeoutSeconds
  );

  const cacheTtlMinutes = pickNumber(
    DEFAULT_FETCH_CACHE_TTL_MINUTES,
    { min: 0 },
    overrides.cacheTtlMinutes,
    section.cacheTtlMinutes
  );

  return {
    readabilityEnabled: pickBool(true, overrides.readabilityEnabled, section.readabilityEnabled),
    maxCharsCap,
    maxResponseBytes,
    maxRedirects: pickNumber(
      DEFAULT_FETCH_MAX_REDIRECTS,
      { min: 0 },
      overrides.maxRedirects,
      section.maxRedirects
    ),
    timeoutSeconds,
    cacheTtlMs: Math.round(cacheTtlMinutes * 60_000),
    userAgent: pickString(overrides.userAgent, section.userAgent) || DEFAULT_FETCH_USER_AGENT,
    pinDns: pickBool(true, overrides.pinDns, section.pinDns),
    ssrfPolicy: {
      ...(section.ssrfPolicy && typeof section.ssrfPolicy === 'object' ? section.ssrfPolicy : {}),
      ...(overrides.ssrfPolicy ?? {})
    },
    firecrawlEnabled: overrides.firecrawlEnabled ?? section.firecrawlEnabled ?? Boolean(apiKey),
    firecrawlApiKey: apiKey,
    firecrawlBaseUrl:
      pickString(overrides.firecrawlBaseUrl, section.firecrawlBaseUrl) || DEFAULT_FIRECRAWL_BASE_URL,
    firecrawlOnlyMainContent: pickBool(
      true,
      overrides.firecrawlOnlyMainContent,
      section.firecrawlOnlyMainContent
    ),
    firecrawlMaxAgeMs: pickNumber(
      DEFAULT_FIRECRAWL_MAX_AGE_MS,
      { min: 0 },
      overrides.firecrawlMaxAgeMs,
      section.firecrawlMaxAgeMs
    ),
    firecrawlProxy: pickString(overrides.firecrawlProxy, section.firecrawlProxy) || 'auto',
    firecrawlStoreInCache: pickBool(
      true,
      overrides.firecrawlStoreInCache,
      section.firecrawlStoreInCache
    ),
    firecrawlTimeoutSeconds: pickNumber(
      timeoutSeconds,
      { min: 1 },
      overrides.firecrawlTimeoutSeconds,
      section.firecrawlTimeoutSeconds
    )
  };
}

/** @param {object} [overrides] */
export function resolveWebSearchConfig(overrides: any = {}) {
  const section = getCrawlConfigSection().webSearch ?? {};
  const providers = mergeAllProviderSections(section, overrides);

  return attachProviderScopeAliases({
    enabled: pickBool(true, overrides.enabled, section.enabled),
    provider: pickString(overrides.provider, section.provider).toLowerCase(),
    region: pickString(overrides.region, section.region),
    safeSearch: pickString(overrides.safeSearch, section.safeSearch) || 'moderate',
    country: pickString(overrides.country, section.country),
    timeoutSeconds: pickNumber(
      DEFAULT_SEARCH_TIMEOUT_SECONDS,
      { min: 1 },
      overrides.timeoutSeconds,
      section.timeoutSeconds
    ),
    cacheTtlMinutes: pickNumber(
      DEFAULT_SEARCH_CACHE_TTL_MINUTES,
      { min: 0 },
      overrides.cacheTtlMinutes,
      section.cacheTtlMinutes
    ),
    maxResults: overrides.maxResults ?? section.maxResults,
    ...providers
  });
}

/** @param {object} [overrides] */
export function buildBrowserRuntime(overrides: any = {}) {
  const section = getCrawlConfigSection().browser ?? {};
  const pw = getPlaywrightRendererConfig();

  const browserTypeRaw = pickString(
    overrides.browserType,
    section.browserType,
    pw.browserType,
    'chromium'
  );
  const browserType = BROWSER_TYPES.has(browserTypeRaw) ? browserTypeRaw : 'chromium';

  const defaultLaunchArgs = [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
  ];

  return {
    browserType,
    headless: pickBool(true, overrides.headless, section.headless, pw.headless),
    wsEndpoint:
      pickString(overrides.wsEndpoint, section.wsEndpoint, pw.wsEndpoint) || undefined,
    executablePath:
      pickString(overrides.executablePath, section.executablePath, pw.chromiumPath) ||
      findSystemBrowser() ||
      undefined,
    launchTimeoutMs: pickNumber(
      120_000,
      { min: 5_000, max: 180_000 },
      overrides.launchTimeoutMs,
      section.launchTimeoutMs,
      pw.playwrightTimeout
    ),
    navigationTimeoutMs: pickNumber(
      60_000,
      { min: 1_000, max: 180_000 },
      overrides.navigationTimeoutMs,
      section.navigationTimeoutMs
    ),
    maxTextChars: pickNumber(
      50_000,
      { min: 1_000 },
      overrides.maxTextChars,
      section.maxTextChars
    ),
    screenshotMaxBytes: pickNumber(
      4 * 1024 * 1024,
      { min: 64_000 },
      overrides.screenshotMaxBytes,
      section.screenshotMaxBytes
    ),
    deviceScaleFactor: pickNumber(
      2,
      { min: 1, max: 4 },
      overrides.deviceScaleFactor,
      section.deviceScaleFactor,
      pw.viewport?.deviceScaleFactor
    ),
    viewport: {
      width: pickNumber(
        1280,
        { min: 320 },
        overrides.viewport?.width,
        section.viewport?.width,
        pw.viewport?.width
      ),
      height: pickNumber(
        720,
        { min: 240 },
        overrides.viewport?.height,
        section.viewport?.height,
        pw.viewport?.height
      )
    },
    launchArgs: pickStringArray(
      defaultLaunchArgs,
      overrides.launchArgs,
      section.launchArgs,
      pw.args
    ),
    ssrfPolicy: {
      allowPrivateNetwork: pickBool(
        false,
        overrides.ssrfPolicy?.allowPrivateNetwork,
        section.ssrfPolicy?.allowPrivateNetwork
      ),
      dangerouslyAllowPrivateNetwork: pickBool(
        false,
        overrides.ssrfPolicy?.dangerouslyAllowPrivateNetwork,
        section.ssrfPolicy?.dangerouslyAllowPrivateNetwork
      ),
      ...(overrides.ssrfPolicy ?? {})
    },
    screenshotFontDir: pickString(overrides.screenshotFontDir, section.screenshotFontDir) || undefined,
    screenshotFontUrlBase:
      pickString(overrides.screenshotFontUrlBase, section.screenshotFontUrlBase) || undefined,
    screenshotFontFiles: pickStringArray(
      [],
      overrides.screenshotFontFiles,
      section.screenshotFontFiles
    ),
    closeTimeoutMs: pickNumber(
      8_000,
      { min: 500, max: 60_000 },
      overrides.closeTimeoutMs,
      section.closeTimeoutMs
    ),
    pageCrashRetries: pickNumber(
      1,
      { min: 0, max: 3 },
      overrides.pageCrashRetries,
      section.pageCrashRetries
    ),
    opTimeoutMs: (() => {
      const raw = overrides.opTimeoutMs ?? section.opTimeoutMs;
      if (raw == null || raw === '' || raw === 0 || raw === false) return undefined;
      return pickNumber(120_000, { min: 5_000, max: 600_000 }, raw);
    })()
  };
}

/**
 * 将 `buildBrowserRuntime()` 结果转为 `PlaywrightAgentSession.launch/using` 选项。
 * 业务方应只调此函数（或 `launchOptionsFromBrowserRuntime`），勿手抄字段以免丢掉
 * navigationTimeoutMs / ssrfPolicy / closeTimeoutMs 等。
 *
 * @param {ReturnType<typeof buildBrowserRuntime>|object} [runtime]
 * @param {object} [overrides] 启动项覆盖（viewport / deviceScaleFactor 等）
 */
export function toPlaywrightAgentLaunchOptions(runtime: any = {}, overrides: any = {}) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const viewport = o.viewport ?? rt.viewport;
  const ssrfPolicy = o.ssrfPolicy ?? rt.ssrfPolicy;

  return {
    browserType: o.browserType ?? rt.browserType ?? 'chromium',
    headless: typeof o.headless === 'boolean' ? o.headless : (rt.headless ?? true),
    wsEndpoint: o.wsEndpoint ?? rt.wsEndpoint,
    executablePath: o.executablePath ?? rt.executablePath,
    launchTimeoutMs: o.launchTimeoutMs ?? rt.launchTimeoutMs,
    launchArgs: o.launchArgs ?? rt.launchArgs,
    deviceScaleFactor: o.deviceScaleFactor ?? rt.deviceScaleFactor,
    viewport:
      viewport && typeof viewport === 'object'
        ? {
            width: viewport.width,
            height: viewport.height
          }
        : undefined,
    extraHTTPHeaders: o.extraHTTPHeaders,
    navigationTimeoutMs: o.navigationTimeoutMs ?? rt.navigationTimeoutMs,
    ssrfPolicy: ssrfPolicy && typeof ssrfPolicy === 'object' ? { ...ssrfPolicy } : undefined,
    closeTimeoutMs: o.closeTimeoutMs ?? rt.closeTimeoutMs,
    pageCrashRetries: o.pageCrashRetries ?? rt.pageCrashRetries,
    opTimeoutMs: o.opTimeoutMs ?? rt.opTimeoutMs
  };
}

/**
 * `buildBrowserRuntime(runtimeOverrides)` → `toPlaywrightAgentLaunchOptions(..., launchOverrides)`
 * @param {object} [runtimeOverrides] 传给 buildBrowserRuntime（含 viewport/deviceScaleFactor）
 * @param {object} [launchOverrides] 仅启动项覆盖
 */
export function launchOptionsFromBrowserRuntime(runtimeOverrides: any = {}, launchOverrides: any = {}) {
  return toPlaywrightAgentLaunchOptions(buildBrowserRuntime(runtimeOverrides), launchOverrides);
}
