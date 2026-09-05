// @ts-nocheck
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { isPathInside } from '#utils/path-guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PlaywrightAgentSession,
  SsrFBlockedError,
  buildBrowserRuntime,
  toPlaywrightAgentLaunchOptions,
  createLocalFontScreenshotHelper
} from '#infrastructure/crawl/index.js';

function resolveBrowserScreenshotSavePath(relPath) {
  const ws = AiWorkflowLoader.getWorkflow('tools')?.workspace;
  if (!ws || typeof relPath !== 'string' || !relPath.trim()) return null;
  const root = path.resolve(ws);
  const target = path.resolve(root, relPath.trim().replace(/^\/+/, ''));
  if (!isPathInside(root, target)) return null;
  return target;
}

/** Playwright 受控浏览器 MCP。 */
export default class BrowserStream extends AiWorkflow {
  /** @type {PlaywrightAgentSession | null} */
  session = null;

  /** @type {ReturnType<typeof buildBrowserRuntime>} */
  browserRuntime;

  constructor() {
    super({
      name: 'browser',
      description: 'Playwright 受控浏览器：导航、正文快照、截图（SSRF 与 web_fetch 一致）',
      version: '1.0.0',
      author: 'XRK',
      priority: 92,
      capabilities: ['tools'],
      frameworkToolSurface: true,
      config: {
        enabled: true,
        temperature: 0.2,
        maxTokens: 8000,
        topP: 0.9
      },
      embedding: { enabled: false }
    });
  }

  async init() {
    this.browserRuntime = buildBrowserRuntime();
    await super.init();
    this.registerBrowserTools();
  }

  async ensureSession() {
    if (this.session) return this.session;
    const rt = this.browserRuntime;
    this.session = await PlaywrightAgentSession.launch(toPlaywrightAgentLaunchOptions(rt));
    this.attachScreenshotHelperIfConfigured();
    RuntimeUtil.makeLog(
      'info',
      `[${this.name}] Playwright 已启动 (${rt.browserType}, headless=${rt.headless}${rt.wsEndpoint ? ', remote' : ''})`,
      'BrowserStream'
    );
    return this.session;
  }

  attachScreenshotHelperIfConfigured() {
    const rt = this.browserRuntime;
    if (!rt.screenshotFontDir || !rt.screenshotFontUrlBase || !this.session) return;
    const fontFiles = rt.screenshotFontFiles ?? [];
    if (!fontFiles.length) return;
    try {
      const helper = createLocalFontScreenshotHelper({
        fontUrlBase: rt.screenshotFontUrlBase,
        fontDir: rt.screenshotFontDir,
        fonts: fontFiles.map((file) => ({ family: path.basename(file, path.extname(file)), file }))
      });
      this.session.attachScreenshotHelper(helper);
    } catch (e) {
      RuntimeUtil.makeLog(
        'warn',
        `[${this.name}] 截图字体助手未启用: ${e?.message || e}`,
        'BrowserStream'
      );
    }
  }

  async closeSessionInternal() {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
      RuntimeUtil.makeLog('debug', `[${this.name}] Playwright 已关闭`, 'BrowserStream');
    }
  }

  registerBrowserTools() {
    this.registerMCPTool('browser_status', {
      description: '查询受控浏览器会话是否已启动（不自动启动浏览器）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const u = this.session?.url?.() ?? '';
        return this.successResponse({
          running: Boolean(this.session),
          currentUrl: u || undefined,
          browserType: this.browserRuntime.browserType,
          headless: this.browserRuntime.headless
        });
      },
      enabled: true
    });

    this.registerMCPTool('browser_start', {
      description: '启动 Playwright 受控浏览器会话（幂等：已启动则直接返回成功）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          await this.ensureSession();
          return this.successResponse({ message: '浏览器会话已就绪' });
        } catch (e) {
          const msg = e?.message || String(e);
          RuntimeUtil.makeLog('error', `[${this.name}] browser_start: ${msg}`, 'BrowserStream');
          return this.errorResponse('BROWSER_START_FAILED', msg);
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_goto', {
      description:
        '在受控浏览器中导航到 URL（http/https）。未启动时会自动启动。受 SSRF 与 web_fetch 相同策略约束。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL' },
          waitUntil: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
            description: 'Playwright waitUntil'
          }
        },
        required: ['url']
      },
      handler: async (args = {}) => {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) return this.errorResponse('INVALID_PARAM', 'url 必填');
        const waitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(args.waitUntil)
          ? args.waitUntil
          : 'load';
        try {
          const s = await this.ensureSession();
          await s.goto(url, {
            waitUntil,
            timeoutMs: this.browserRuntime.navigationTimeoutMs,
            ssrfPolicy: this.browserRuntime.ssrfPolicy
          });
          const title = await s.title();
          return this.successResponse({ url, title });
        } catch (e) {
          if (e instanceof SsrFBlockedError || e?.name === 'SsrFBlockedError') {
            return this.errorResponse('SSRF_BLOCKED', e.message);
          }
          const msg = e?.message || String(e);
          RuntimeUtil.makeLog('error', `[${this.name}] browser_goto: ${msg}`, 'BrowserStream');
          return this.errorResponse('BROWSER_GOTO_FAILED', msg);
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_page_text', {
      description: '读取当前页标题与可见正文（body innerText，超长按配置截断）。需已导航。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          if (!this.session) {
            return this.errorResponse('NO_SESSION', '请先 browser_start 或 browser_goto');
          }
          const title = await this.session.title();
          let text = await this.session.textContent();
          let truncated = false;
          if (text.length > this.browserRuntime.maxTextChars) {
            text = text.slice(0, this.browserRuntime.maxTextChars);
            truncated = true;
          }
          return this.successResponse({ title, text, truncated, maxChars: this.browserRuntime.maxTextChars });
        } catch (e) {
          return this.errorResponse('BROWSER_PAGE_TEXT_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_screenshot', {
      description:
        '截取 Playwright 当前页 PNG（非 OS 桌面屏）。浏览器默认 headless 在服务端运行，用户界面不可见；交付截图请用本工具，勿用 desktop.screenshot。默认写入工作区 output/ 并返回 base64 预览。',
      inputSchema: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: '是否整页截图', default: false },
          selector: {
            type: 'string',
            description: '区域选择器（非空时优先区域截图；已 attach 截图助手时先应用字体/样式）'
          },
          savePath: {
            type: 'string',
            description: '相对工作区路径保存 PNG（默认 output/browser-screenshot-<ts>.png；传空字符串则仅返回 base64）'
          }
        },
        required: []
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) {
            return this.errorResponse('NO_SESSION', '请先 browser_start 或 browser_goto');
          }
          const fullPage = args.fullPage === true;
          const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
          const buf = selector
            ? await this.session.captureRegion(selector)
            : await this.session.screenshot({ fullPage, type: 'png' });
          if (buf.length > this.browserRuntime.screenshotMaxBytes) {
            return this.errorResponse(
              'SCREENSHOT_TOO_LARGE',
              `PNG ${buf.length} 字节超过 screenshotMaxBytes=${this.browserRuntime.screenshotMaxBytes}`
            );
          }
          let savePathRel =
            args.savePath === ''
              ? null
              : (typeof args.savePath === 'string' && args.savePath.trim()
                  ? args.savePath.trim()
                  : `output/browser-screenshot-${Date.now()}.png`);
          let savedPath;
          if (savePathRel) {
            const abs = resolveBrowserScreenshotSavePath(savePathRel);
            if (abs) {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              await fs.writeFile(abs, buf);
              savedPath = savePathRel.replace(/\\/g, '/');
            }
          }
          return this.successResponse({
            mimeType: 'image/png',
            base64: buf.toBase64(),
            bytes: buf.length,
            fullPage,
            selector: selector || undefined,
            headless: this.browserRuntime.headless,
            savedPath
          });
        } catch (e) {
          return this.errorResponse('BROWSER_SCREENSHOT_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_snapshot', {
      description:
        'ARIA 文本快照（非 PNG 截图）：返回 snapshot 与 refs（e1/e2…）供 browser_act/click/type 定位。要看页面图像请用 browser_screenshot。',
      inputSchema: {
        type: 'object',
        properties: {
          interactive: {
            type: 'boolean',
            description: '仅返回可交互元素（button/link/textbox 等）',
            default: false
          },
          compact: { type: 'boolean', description: '压缩无 ref 的结构节点', default: true },
          maxDepth: { type: 'number', description: '最大缩进深度' },
          selector: { type: 'string', description: '根选择器，默认整页 :root' },
          timeoutMs: { type: 'number', description: 'ariaSnapshot 超时毫秒', default: 5000 }
        },
        required: []
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start 或 browser_goto');
          const out = await this.session.roleSnapshot({
            interactive: args.interactive === true,
            compact: args.compact !== false,
            maxDepth: args.maxDepth,
            selector: args.selector,
            timeoutMs: args.timeoutMs
          });
          return this.successResponse({
            url: this.session.url(),
            snapshot: out.snapshot,
            refs: out.refs,
            stats: out.stats
          });
        } catch (e) {
          return this.errorResponse('BROWSER_SNAPSHOT_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_act', {
      description:
        '统一浏览器交互：kind=click|type|press|hover|select|wait|evaluate。目标用 ref（snapshot 的 eN）或 selector。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'click',
              'type',
              'fill',
              'press',
              'hover',
              'select',
              'wait',
              'evaluate',
              'batch',
              'scrollIntoView'
            ],
            description: '动作类型'
          },
          ref: { type: 'string', description: 'browser_snapshot 返回的 ref，如 e3' },
          selector: { type: 'string', description: 'CSS 选择器（与 ref 二选一）' },
          text: { type: 'string', description: 'type/fill 文本' },
          key: { type: 'string', description: 'press 按键，默认 Enter' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: 'select 选项值'
          },
          force: { type: 'boolean', description: 'click 强制点击', default: false },
          clear: { type: 'boolean', description: 'type 前清空', default: true },
          pressEnter: { type: 'boolean', description: 'type 后按 Enter', default: false },
          timeMs: { type: 'number', description: 'wait 固定延时' },
          loadState: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: 'wait 页面状态'
          },
          expression: { type: 'string', description: 'evaluate JS 函数体' },
          actions: {
            type: 'array',
            description: 'batch：子动作数组',
            items: { type: 'object' }
          },
          stopOnError: { type: 'boolean', description: 'batch 遇错是否停止', default: true },
          timeoutMs: { type: 'number', default: 8000 }
        },
        required: ['kind']
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start 或 browser_goto');
          const result = await this.session.runAct({
            ...args,
            ssrfPolicy: this.browserRuntime.ssrfPolicy
          });
          return this.successResponse(result);
        } catch (e) {
          if (e instanceof SsrFBlockedError || e?.name === 'SsrFBlockedError') {
            return this.errorResponse('SSRF_BLOCKED', e.message);
          }
          return this.errorResponse('BROWSER_ACT_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_tabs', {
      description: '列出所有标签页（index、url、title、active）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          const tabs = await this.session.listTabs();
          return this.successResponse({ tabs });
        } catch (e) {
          return this.errorResponse('BROWSER_TABS_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_tab_new', {
      description: '新建标签页并可选用 browser_goto 同款 SSRF 策略导航。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '可选 URL，默认 about:blank' }
        },
        required: []
      },
      handler: async (args = {}) => {
        try {
          await this.ensureSession();
          const url = typeof args.url === 'string' ? args.url.trim() : '';
          const out = await this.session.newTab(url || 'about:blank', {
            ssrfPolicy: this.browserRuntime.ssrfPolicy
          });
          return this.successResponse(out);
        } catch (e) {
          if (e instanceof SsrFBlockedError || e?.name === 'SsrFBlockedError') {
            return this.errorResponse('SSRF_BLOCKED', e.message);
          }
          return this.errorResponse('BROWSER_TAB_NEW_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_tab_close', {
      description: '关闭指定 index 标签页（不可关闭最后一个）。',
      inputSchema: {
        type: 'object',
        properties: { index: { type: 'number', description: '标签 index，默认当前页' } },
        required: []
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          const out = await this.session.closeTab(args.index);
          return this.successResponse(out);
        } catch (e) {
          return this.errorResponse('BROWSER_TAB_CLOSE_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_tab_focus', {
      description: '切换活动标签页。',
      inputSchema: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index']
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          if (typeof args.index !== 'number') return this.errorResponse('INVALID_PARAM', 'index 必填');
          const out = await this.session.focusTab(Math.floor(args.index));
          return this.successResponse(out);
        } catch (e) {
          return this.errorResponse('BROWSER_TAB_FOCUS_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_console', {
      description: '读取当前页捕获的 console 消息（页面观测）。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', default: 50 } },
        required: []
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 50;
          return this.successResponse({ messages: this.session.getConsoleMessages(limit) });
        } catch (e) {
          return this.errorResponse('BROWSER_CONSOLE_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_network', {
      description: '读取当前页捕获的网络请求摘要。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', default: 100 } },
        required: []
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          const limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 100;
          return this.successResponse({ requests: this.session.getNetworkRequests(limit) });
        } catch (e) {
          return this.errorResponse('BROWSER_NETWORK_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_dialog_arm', {
      description: '预设下一次弹窗自动 accept/dismiss（预设弹窗响应）。',
      inputSchema: {
        type: 'object',
        properties: {
          accept: { type: 'boolean' },
          promptText: { type: 'string' },
          timeoutMs: { type: 'number' }
        },
        required: ['accept']
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          this.session.armDialog({
            accept: args.accept === true,
            promptText: args.promptText,
            timeoutMs: args.timeoutMs
          });
          return this.successResponse({ armed: true });
        } catch (e) {
          return this.errorResponse('BROWSER_DIALOG_ARM_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_dialog_respond', {
      description: '响应当前 pending 弹窗（alert/confirm/prompt）。',
      inputSchema: {
        type: 'object',
        properties: {
          accept: { type: 'boolean' },
          promptText: { type: 'string' },
          dialogId: { type: 'string' }
        },
        required: ['accept']
      },
      handler: async (args = {}) => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          const record = await this.session.respondDialog({
            accept: args.accept === true,
            promptText: args.promptText,
            dialogId: args.dialogId
          });
          return this.successResponse({ dialog: record });
        } catch (e) {
          return this.errorResponse('BROWSER_DIALOG_RESPOND_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_observed_state', {
      description: '查询弹窗等可观测浏览器状态（pending/recent dialogs）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        try {
          if (!this.session) return this.errorResponse('NO_SESSION', '请先 browser_start');
          return this.successResponse(this.session.getObservedBrowserState());
        } catch (e) {
          return this.errorResponse('BROWSER_OBSERVED_STATE_FAILED', e?.message || String(e));
        }
      },
      enabled: true
    });

    this.registerMCPTool('browser_close', {
      description: '关闭 Playwright 浏览器会话并释放进程。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        await this.closeSessionInternal();
        return this.successResponse({ message: '已关闭' });
      },
      enabled: true
    });
  }

  buildSystemPrompt() {
    return [
      '本工作流提供受控浏览器（Playwright）MCP：',
      'browser_status / start / goto / tabs / tab_* / snapshot / browser_act（click|type|wait|evaluate|batch）/ page_text / screenshot / console / network / dialog_* / close。',
      '流程：goto → snapshot（读 ref=eN）→ browser_act → screenshot 或 page_text。已移除 browser_click/type/wait/evaluate 薄包装。',
      '浏览器默认 headless；页面截图用 browser_screenshot，勿用 desktop.screenshot（OS 全屏）。',
      '导航与交互做 SSRF 复检。无 JS 静态页优先 web.web_fetch。'
    ].join('\n');
  }

  async cleanup() {
    await this.closeSessionInternal();
    await super.cleanup();
  }
}
