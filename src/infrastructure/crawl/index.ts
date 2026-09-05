/**
 * 爬虫 / 外联抓取统一入口（HTTP、SSRF、web_fetch、Playwright、增强截图）
 * 模块：ssrf-guard | web-fetch-executor | web-fetch-utils | playwright-session | page-screenshot-enhance
 */
export { fetchWithPolicy } from '#utils/fetch-with-retry.js'
export { SsrFBlockedError, assertUrlSafeForFetch, isPrivateOrReservedIpv4, isBlockedIpv6 } from './ssrf-guard.js'
export {
  buildWebFetchRuntime,
  runWebFetch,
  DEFAULT_FETCH_MAX_CHARS,
  FETCH_CACHE
} from './web-fetch-executor.js'
export {
  htmlToMarkdown,
  markdownToText,
  truncateText,
  extractBasicHtmlContent,
  extractReadableContent
} from './web-fetch-utils.js'
export { PlaywrightAgentSession } from './playwright-session.js'
export { isPlaywrightCrashError, softClosePlaywright, softClosePlaywrightTree } from './playwright-crash.js'
export {
  createLocalFontScreenshotHelper,
  DEFAULT_DEVICE_SCALE_FACTOR,
  DOM_TWEAK_LABEL_COLON_HALF
} from './page-screenshot-enhance.js'

export { fetchWithSsrFGuard } from './fetch-guard.js'
export {
  assertBrowserNavigationResultAllowed,
  assertBrowserNavigationAllowed,
  didCrossDocumentUrlChange,
  SsrFBlockedError as BrowserNavigationBlockedError
} from './browser-navigation-guard.js'
export {
  buildRoleSnapshotFromAriaSnapshot,
  buildRoleSnapshotFromAiSnapshot,
  parseRoleRef,
  getRoleSnapshotStats
} from './pw-role-snapshot.js'
export { refLocator, resolveInteractionTarget } from './pw-ref-locator.js'
export {
  ACT_MAX_BATCH_ACTIONS,
  clampInteractionTimeoutMs,
  clampWaitTimeoutMs
} from './act-policy.js'
export {
  ensurePageState,
  getObservedBrowserStateForPage,
  BrowserObservedDialogBlockedError,
  isBrowserObservedDialogBlockedError
} from './pw-page-state.js'
export {
  resolvePinnedHostnameWithPolicy,
  createPinnedDispatcher,
  closeDispatcher,
  mergeSsrFPolicies
} from './ssrf-policy.js'
export {
  gotoWithNavigationGuard,
  InvalidBrowserNavigationUrlError,
  PLAYWRIGHT_WAIT_UNTIL,
  normalizePlaywrightWaitUntil
} from './browser-navigation-guard.js'
export {
  buildBrowserRuntime,
  toPlaywrightAgentLaunchOptions,
  launchOptionsFromBrowserRuntime,
  resolveWebFetchRuntime,
  resolveWebSearchConfig,
  getCrawlConfigSection,
  getPlaywrightRendererConfig,
  getWebSearchProviderScope
} from './crawl-config.js'
export {
  buildWebSearchRuntime,
  runWebSearch,
  listWebSearchProviders,
  resolveWebSearchProviderId,
  WEB_SEARCH_PROVIDERS,
  getWebSearchProvider
} from './web-search-executor.js'
export { listWebSearchProviderMeta, isWebSearchProviderConfigured } from './web-search-registry.js'
export { runDuckDuckGoSearch, parseDuckDuckGoHtml } from './web-search-duckduckgo.js'
export { runBraveSearch } from './web-search-brave.js'
export { runPerplexitySearch } from './web-search-perplexity.js'
export { runExaSearch } from './web-search-exa.js'
export { runTavilySearch } from './web-search-tavily.js'
export { runFirecrawlSearch } from './web-search-firecrawl.js'
export { runSearxngSearch } from './web-search-searxng.js'
export { runGeminiSearch } from './web-search-gemini.js'
export { runMiniMaxSearch } from './web-search-minimax.js'
export { runParallelSearch } from './web-search-parallel.js'
export { runParallelFreeSearch, PARALLEL_MCP_SEARCH_URL } from './web-search-parallel-free.js'
export { callMcpTool } from './web-search-mcp-client.js'
export { runKimiSearch } from './web-search-kimi.js'
export { runOllamaSearch } from './web-search-ollama.js'
export { withTrustedWebSearchEndpoint, withSelfHostedWebSearchEndpoint } from './web-search-endpoint.js'
export {
  SEARCH_CACHE,
  MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  buildSearchCacheKey,
  readCachedSearchPayload,
  writeCachedSearchPayload
} from './web-search-shared.js'
