import './bootstrap-globals.js';
/**
 * AgentRuntime = **Host** (HTTP/WS/多 bot/Loader)，不是 LLM agent loop。
 * 勿在此文件堆 turn/工具结算/会话笔录真源 —— Agent loop 在 `@xrkseek/harness`（见 docs/adr/0001 · harness-module-loop.md）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
// @ts-expect-error no @types/express
import express from 'express';
import http from 'node:http';
// @ts-expect-error no @types/ws
import { WebSocketServer } from 'ws';
// @ts-expect-error no @types/multer
import multer from 'multer';
import chalk from 'chalk';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import HttpApiLoader from '#infrastructure/http/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { getRuntimeGlobal } from '#utils/runtime-globals.js';
import runtimeConfig from '#infrastructure/config/config.js';
import {
  callSubserver as callSubserverApi,
  fetchSubserverToPath as fetchSubserverToPathApi,
  formatSubserverError,
  getSubserverConfig,
  isSubserverConnectionError,
} from '#utils/subserver-client.js';
import { resolveSubserverFileUpstream } from '#utils/subserver-file-proxy.js';
import paths from '#utils/paths.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import { normalizeError } from '#utils/normalize-error.js';
import HTTPBusinessLayer from '#utils/http-business.js';
import { HttpResponse } from '#utils/http-utils.js';
import { InputValidator } from '#utils/input-validator.js';
import * as runtimeAuth from '#infrastructure/http/runtime-auth.js';
import * as runtimeWs from '#infrastructure/http/runtime-ws.js';
import * as runtimeListen from '#infrastructure/http/runtime-listen.js';
import * as runtimeProxy from '#infrastructure/http/runtime-proxy.js';
import * as runtimeMiddleware from '#infrastructure/http/runtime-middleware.js';
import * as runtimeBoot from '#infrastructure/http/runtime-boot.js';
import * as runtimeNet from '#infrastructure/http/runtime-net.js';

/** 静态资源扩展名，用于基础放行（非鉴权） */
const AUTH_STATIC_EXT_REGEX = /\.(html|css|js|json|png|jpg|jpeg|gif|svg|webp|ico|mp4|webm|mp3|wav|pdf|zip|woff|woff2|ttf|otf)$/i;

/**
 * AgentRuntime主类
 * 
 * 系统的核心类，负责HTTP服务器、WebSocket、插件管理、配置管理等。
 * 继承自EventEmitter，支持事件驱动架构。
 * 
 * @class AgentRuntime
 * @extends EventEmitter
 * @example
 * // 仅入口允许（start.js / debug.js）；Core 业务用裸名 AgentRuntime
 * import AgentRuntime from './agent-runtime.js';
 * const runtime = new AgentRuntime();
 * await runtime.run({ port: 8086 });
 * runtime.on('online', ({ url }) => console.log(url));
 */
export default class AgentRuntime extends EventEmitter {
  [key: string]: any;
  _wsConnections: any = new Map();
  _rateLimiters: any = new Map();
  proxyMiddlewares: any = new Map();
  domainConfigs: any = new Map();
  sslContexts: any = new Map();
  bots: any = {};
  tasker: any[] = [];
  server: any = null;
  httpsServer: any = null;
  multipartUpload: any = null;
  _wsHeartbeatInterval: any = null;
  apiKey = '';
  httpPort: any = null;
  httpsPort: any = null;
  actualPort: any = null;
  actualHttpsPort: any = null;
  proxyEnabled = false;
  proxyApp: any = null;
  proxyServer: any = null;
  proxyHttpsServer: any = null;
  _compiledHiddenFileMatchers: any = null;
  _authWhitelistCache: any = { ref: null, rules: [] };

  /**
   * 仅入口允许 `new AgentRuntime()`（start.js / debug.js）；Core 业务用裸名。
   */
  constructor() {
    super();

    this.stat = { start_time: Date.now() / 1000 };
    this.bot = this;
    this.uin = this._createUinManager();

    this.express = Object.assign(express(), { skip_auth: [], quiet: [] });

    const wsConfig = runtimeConfig.server?.websocket || {};
    const perMessageDeflateCfg = wsConfig?.perMessageDeflate || {};
    const perMessageDeflateEnabled = perMessageDeflateCfg?.enabled !== false;
    const perMessageDeflate = perMessageDeflateEnabled ? {
      zlibDeflateOptions: {
        chunkSize: Number(perMessageDeflateCfg?.zlibDeflateOptions?.chunkSize) || 1024,
        memLevel: Number(perMessageDeflateCfg?.zlibDeflateOptions?.memLevel) || 7,
        level: Number(perMessageDeflateCfg?.zlibDeflateOptions?.level) || 3,
      },
      zlibInflateOptions: {
        chunkSize: Number(perMessageDeflateCfg?.zlibInflateOptions?.chunkSize) || (10 * 1024),
      },
      clientNoContextTakeover: perMessageDeflateCfg?.clientNoContextTakeover !== false,
      serverNoContextTakeover: perMessageDeflateCfg?.serverNoContextTakeover !== false,
      serverMaxWindowBits: Number(perMessageDeflateCfg?.serverMaxWindowBits) || 10,
      concurrencyLimit: Number(perMessageDeflateCfg?.concurrencyLimit) || 10,
      threshold: Number(perMessageDeflateCfg?.threshold) || 1024,
    } : false;

    const maxPayload = Number(wsConfig?.maxPayload);
    const maxPayloadBytes = Number.isFinite(maxPayload) && maxPayload > 0
      ? maxPayload
      : (100 * 1024 * 1024);

    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate,
      maxPayload: maxPayloadBytes,
      clientTracking: wsConfig?.clientTracking !== false,
    });
    this.wsf = Object.create(null);
    this.fs = Object.create(null);

    const cacheTtl = Number(runtimeConfig.server?.misc?.cache?.ttlMs);
    this._cache = RuntimeUtil.getMap('core_cache', {
      ttl: (Number.isFinite(cacheTtl) && cacheTtl > 0) ? cacheTtl : 60000,
      autoClean: true,
    });
    this.url = runtimeNet.getConfiguredServerUrl();

    // runtimeConfig.server 可能尚未完全加载；run() 内会再初始化
    this.httpBusiness = new HTTPBusinessLayer(runtimeConfig.server || {});
    this._mountHttpBusinessMethods();

    this.HttpApiLoader = HttpApiLoader;
    this._initHttpServer();
    this._initSubServer();

    return this._createProxy();
  }

  _initSubServer() {
    /** 可选扩展：业务 Core 调用子服务 apis/ 时使用，见 #utils/subserver-client.js */
    this.callSubserver = async (requestPath: any, options: any = {}) => {
      try {
        return await callSubserverApi(requestPath, options);
      } catch (error: any) {
        const err = normalizeError(error);
        const cause = err.cause ? ` cause=${(err.cause as any)?.message ?? err.cause}` : '';
        RuntimeUtil.makeLog('debug', `子服务端调用失败 [${requestPath}]: ${err.message}${cause}`, 'AgentRuntime');
        throw err;
      }
    };
    this.fetchSubserverToPath = async (requestPath: any, options: any = {}) => {
      try {
        return await fetchSubserverToPathApi(requestPath, options);
      } catch (error: any) {
        const err = normalizeError(error);
        const cause = err.cause ? ` cause=${(err as any).cause?.message ?? (err as any).cause}` : '';
        RuntimeUtil.makeLog('debug', `子服务端文件拉取失败 [${requestPath}]: ${err.message}${cause}`, 'AgentRuntime');
        throw err;
      }
    };
  }
  /**
   * 静态方法版本的makeError
   * @static
   * @param {string|Error} message - 错误消息或错误对象
   * @param {string} [type='Error'] - 错误类型
   * @param {Object} [details={}] - 额外的错误详情
   * @returns {Error} 标准化的错误对象
   */
  makeError(message: any, type: any = 'Error', details: any = {}) {
    let error;

    if ((Error as any).isError(message)) {
      error = message;
      if (type === 'Error' && error.type) {
        type = error.type;
      }
    } else {
      error = new Error(message);
    }

    error.type = type;
    error.timestamp = Date.now();

    if (details && typeof details === 'object') {
      Object.assign(error, details);
    }

    error.source = 'AgentRuntime';
    const logMessage = `${type}: ${error.message}`;
    const logDetails = Object.keys(details).length > 0 ?
      chalk.gray(` Details: ${JSON.stringify(details)}`) : '';

    RuntimeUtil.makeLog('error', chalk.red(`✗ ${logMessage}${logDetails}`), type);

    if (error.stack && (runtimeConfig as any).debug) {
      RuntimeUtil.makeLog('debug', chalk.gray(error.stack), type);
    }

    return error;
  }

  _createUinManager(): any {
    return Object.assign([], {
      toJSON(this: any) {
        if (!this.now) {
          if (this.length <= 2) return this[this.length - 1] || "";
          const array = this.slice(1);
          this.now = array[Math.floor(Math.random() * array.length)];
          setTimeout(() => delete this.now, 60000);
        }
        return this.now;
      },
      toString(this: any, raw: any, ...args: any[]) {
        return raw === true ?
          Array.prototype.toString.apply(this, args as any) :
          this.toJSON().toString(raw, ...args);
      },
      includes(this: any, value: any) {
        return this.some((i: any) => i == value);
      }
    }) as any;
  }

  _initHttpServer() {
    // HTTP服务器配置：优先读取 server.yaml（performance.keepAlive / performance.httpServer）
    const perfCfg = runtimeConfig.server?.performance || {};
    const keepAliveCfg = perfCfg?.keepAlive || {};
    const httpServerCfg = perfCfg?.httpServer || {};
    
    const keepAliveEnabled = keepAliveCfg?.enabled !== false;
    const keepAliveInitialDelay = Number(keepAliveCfg?.initialDelay) || 1000;
    const socketTimeout = Number(httpServerCfg?.socketTimeout) || Number(keepAliveCfg?.timeout) || 120000;
    const serverTimeout = Number(httpServerCfg?.serverTimeout) || Number(keepAliveCfg?.timeout) || 120000;
    const headersTimeout = Number(httpServerCfg?.headersTimeout) || 60000;
    const maxHeadersCount = Number(httpServerCfg?.maxHeadersCount) || 2000;
    const maxRequestsPerSocket = Number(httpServerCfg?.maxRequestsPerSocket);

    // HTTP服务器配置（优化性能）
    const serverOptions = {
      keepAlive: keepAliveEnabled,
      keepAliveInitialDelay,
      maxHeadersCount,
      maxRequestsPerSocket: Number.isFinite(maxRequestsPerSocket) ? maxRequestsPerSocket : 0, // 0 = 无限制（适合长连接）
      timeout: serverTimeout,
      headersTimeout
    };
    
    this.server = http.createServer(serverOptions, this.express)
      .on("error", err => this._handleServerError(err, false))
      .on("upgrade", this.wsConnect.bind(this))
      .on("connection", (socket) => {
        // 设置socket超时
        socket.setTimeout(socketTimeout);
        socket.setKeepAlive(keepAliveEnabled, keepAliveInitialDelay);
      });
  }

  _handleServerError(err: any, isHttps: any) {
    const handler = this[`server${err.code}`];
    if (typeof handler === "function") {
      return handler.call(this, err, isHttps);
    }
    errorHandler.handle(
      err,
      { context: isHttps ? 'HTTPS服务器' : 'HTTP服务器', code: ErrorCodes.SYSTEM_ERROR },
      true
    );
    RuntimeUtil.makeLog("error", err, isHttps ? "HTTPS服务器" : "HTTP服务器");
  }

  /**
   * 初始化代理应用和服务器
   */
  async _initProxyApp() {
    return runtimeProxy.initProxyApp(this as any);
  }

  /**
   * 挂载 HTTP 业务层方法到 AgentRuntime 实例（文档：docs/runtime-surface.md）
   */
  _mountHttpBusinessMethods() {
    // 挂载代理管理器方法
    if (this.httpBusiness?.proxyManager) {
      this.selectProxyUpstream = (domain: any, algorithm: any, clientIP: any) => {
        return this.httpBusiness.proxyManager.selectUpstream(domain, algorithm, clientIP);
      };
      
      this.getProxyStats = () => {
        return this.httpBusiness.proxyManager.getStats();
      };
    }
    
    // 挂载CDN管理器方法
    if (this.httpBusiness?.cdnManager) {
      this.isCDNRequest = (req: any) => {
        return this.httpBusiness.cdnManager.isCDNRequest(req);
      };
      
      this.setCDNHeaders = (res: any, filePath: any, req: any) => {
        return this.httpBusiness.cdnManager.setCDNHeaders(res, filePath, req);
      };
    }
    
    // 挂载重定向管理器方法
    if (this.httpBusiness?.redirectManager) {
      this.handleRedirect = (req: any, res: any) => {
        return this.httpBusiness.redirectManager.check(req, res);
      };
    }
  }

  /**
   * 配置加载后重建 HTTPBusinessLayer 并重新挂载方法
   *（constructor 时 server 配置可能尚未就绪）
   */
  _reinitHttpBusiness() {
    this.httpBusiness = new HTTPBusinessLayer(runtimeConfig.server || {});
    this._mountHttpBusinessMethods();
  }


  /**
   * 中间件与系统路由装配
   */
  async _initializeMiddlewareAndRoutes() {
    return runtimeMiddleware.initializeMiddlewareAndRoutes(this as any);
  }

  _parseByteSize(value: any, fallback: any = 10 * 1024 * 1024) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
    if (typeof value !== 'string') return fallback;
    const s = value.trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g|tb|t)?$/i);
    if (!m) return fallback;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    const unit = (m[2] || 'b').toLowerCase();
    const mul =
      unit === 'b' ? 1 :
      (unit === 'kb' || unit === 'k') ? 1024 :
      (unit === 'mb' || unit === 'm') ? 1024 ** 2 :
      (unit === 'gb' || unit === 'g') ? 1024 ** 3 :
      (unit === 'tb' || unit === 't') ? 1024 ** 4 :
      1;
    return Math.floor(n * mul);
  }

  _setupMultipartUploader() {
    this.multipartUpload = this._createMultipartUploader();
  }


  _createMultipartUploader(options: any = {}) {
    const limitsCfg = runtimeConfig.server.limits || {};
    const fileSize = this._parseByteSize(options.fileSize || limitsCfg.fileSize || '100mb', 100 * 1024 * 1024);
    const files = Number.isFinite(Number(options.files))
      ? Number(options.files)
      : (Number.isFinite(Number(limitsCfg.files)) ? Number(limitsCfg.files) : 8);

    const multerOptions: any = {
      limits: { fileSize, files }
    };
    if (options.storage) multerOptions.storage = options.storage;
    if (options.fileFilter) multerOptions.fileFilter = options.fileFilter;
    return multer(multerOptions);
  }


  /**
   * 创建 AgentRuntime 代理：AgentRuntime[self_id] → bots 映射；未命中时透传 RuntimeUtil 静态成员（文档：docs/runtime-surface.md）
   */
  _createProxy() {
    const botMap = this.bots;
    const isBotEntry = (prop: any, value: any) => {
      if (Reflect.has(this, prop)) return false;
      if (typeof prop !== 'string') return false;
      if (!value || typeof value !== 'object') return false;
      return Boolean(
        value.tasker ||
        value.tasker_type ||
        value.self_id ||
        value.uin
      );
    };

    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop === Symbol.toStringTag) return 'AgentRuntime';
        // 1. 优先返回 AgentRuntime 自身属性
        if (Reflect.has(target, prop)) {
          return Reflect.get(target, prop, receiver);
        }

        // 2. 其次返回已注册的子 AgentRuntime 实例
        if (prop in botMap) {
          return botMap[prop];
        }

        // 3. 最后透明代理到 RuntimeUtil 的静态方法/属性（仅限自有属性，避免 Function 原型污染）
        if (typeof prop === 'string' && Object.hasOwn(RuntimeUtil, prop)) {
          const utilValue = (RuntimeUtil as any)[prop];
          return typeof utilValue === 'function'
            ? utilValue.bind(RuntimeUtil)
            : utilValue;
        }

      },
      set: (target, prop, value, receiver) => {
        if (isBotEntry(prop, value)) {
          botMap[prop] = value;
          return true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
      has: (target, prop) => {
        return Reflect.has(target, prop) || 
               prop in botMap || 
               (typeof prop === 'string' && Object.hasOwn(RuntimeUtil, prop));
      },
      ownKeys: (target) => {
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, prop) => {
        if (Reflect.has(target, prop)) {
          return Reflect.getOwnPropertyDescriptor(target, prop);
        }
      }
    });
  }

  /**
   * 生成API密钥
   */
  async generateApiKey() {
    return runtimeAuth.generateApiKey(this as any);
  }

  /**
   * 认证中间件（HTTP）
   * 仅负责基础放行规则：静态资源
   * 具体业务鉴权（如 system-Core HTTP / 各 Core 自定义）由各自模块自行处理
   */
  _authMiddleware(req: any, res: any, next: any) {
    if (this._checkHeadersSent(res, next)) return;

    req.rid = `${req.ip}:${req.socket.remotePort}`;
    req.sid = `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`;

    if (AUTH_STATIC_EXT_REGEX.test(req.path)) {
      RuntimeUtil.makeLog('debug', `[Auth] 放行：静态资源 path=${req.path}`, '认证');
      return next();
    }

    next();
  }

  /**
   * 检查API授权
   * 当 server.auth.apiKey.enabled 为 true 时，必须提供有效密钥；密钥未加载或缺失时一律拒绝
   */
  checkApiAuthorization(req: any, options: any = {}) {
    return runtimeAuth.checkApiAuthorization(this as any, req, options);
  }

  /**
   * 检查响应是否已发送（辅助方法，减少重复代码）
   * @param {Object} res - Express响应对象
   * @param {Function} [next] - Express next函数（可选）
   * @param {Error} [err] - 错误对象（可选，用于错误处理器）
   * @returns {boolean} 如果响应已发送返回true
   */
  _checkHeadersSent(res: any, next?: any, err?: any) {
    if (res.headersSent) {
      if (next) {
        if (err) {
          return next(err);
        }
        return next();
      }
      return true;
    }
    return false;
  }

  /**
   * 子服务 data/ 文件直链：本地优先，缺失时按 data/<dir>/ 前缀代理到对应 runtime 的 /api/{group}/file
   */
  async _subserverFileHandler(req: any, res: any) {
    if (this._checkHeadersSent(res)) return;

    const rel = String(req.query.path || '').trim();
    if (!rel) {
      return HttpResponse.validationError(res, '缺少 path 参数');
    }

    let localPath;
    try {
      localPath = InputValidator.validatePath(rel, paths.root);
      InputValidator.assertPathUnderRoots(localPath, [paths.data]);
    } catch {
      return HttpResponse.validationError(res, '非法路径');
    }

    try {
      await fs.access(localPath);
      const stat = await fs.stat(localPath);
      if (!stat.isFile()) {
        return HttpResponse.notFound(res, '文件不存在');
      }

      const ext = path.extname(localPath).toLowerCase();
      const mime = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(localPath))}"`);
      return res.sendFile(localPath);
    } catch {
      /* 本地无文件时尝试从子服务流式代理 */
    }

    const upstream = resolveSubserverFileUpstream(rel);
    if (!upstream) {
      return HttpResponse.notFound(res, '文件不存在');
    }

    try {
      const response: any = await callSubserverApi(upstream.upstream, {
        method: 'GET',
        query: { path: rel },
        rawResponse: true,
        timeout: 600_000,
        runtime: upstream.runtime
      });

      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      const contentDisposition = response.headers.get('content-disposition');
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

      if (!response.body) {
        return HttpResponse.error(res, new Error('子服务端返回空响应'), 502, 'subserver-file');
      }

      res.status(response.status);
      await pipeline(Readable.fromWeb(response.body), res);
    } catch (error: any) {
      if (isSubserverConnectionError(error)) {
        const hint = formatSubserverError(error, getSubserverConfig(upstream.runtime));
        return HttpResponse.error(res, new Error(hint), 503, 'subserver-file');
      }
      return HttpResponse.notFound(res, '文件不存在');
    }
  }

  /**
   * 文件处理器
   */
  _fileHandler(req: any, res: any) {
    if (this._checkHeadersSent(res)) return;
    
    const url = req.url.replace(/^\//, "");
    let file = this.fs[url];
    
    if (!file) {
      file = this.fs[404];
      if (!file) {
        if (!res.headersSent) {
          return res.status(404).json({ error: '未找到', file: url });
        }
        return;
      }
    }
    
    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--;
      } else {
        file = this.fs.timeout;
        if (!file) {
          if (!res.headersSent) {
            return res.status(410).json({
              error: '已过期',
              message: '文件访问次数已达上限'
            });
          }
          return;
        }
      }
    }
    
    // 确保在发送响应前设置头部
    if (!res.headersSent) {
      if (file.type?.mime) {
        res.setHeader("Content-Type", file.type.mime);
      }
      res.setHeader("Content-Length", file.buffer.length);
      res.setHeader("Cache-Control", "no-cache");
      
      RuntimeUtil.makeLog("debug", `文件发送：${file.name} (${RuntimeUtil.formatFileSize(file.buffer.length)})`, '服务器');
      
      res.send(file.buffer);
    }
  }


  /**
   * 停止WebSocket心跳检测
   */
  _stopWebSocketHeartbeat() {
    return runtimeWs.stopWebSocketHeartbeat(this as any);
  }

  /**
   * 获取WebSocket连接统计
   */
  getWebSocketStats() {
    return runtimeWs.getWebSocketStats(this as any);
  }

  /**
   * WebSocket连接处理
   * 所有 Tasker 暴露的 WS 路径（AgentRuntime.wsf）在此统一进行系统级鉴权：
   * - 其余连接若 server.auth.apiKey.enabled !== false，则必须通过 API Key 校验
   */
  wsConnect(req: any, socket: any, head: any) {
    return runtimeWs.wsConnect(this as any, req, socket, head);
  }

  /**
   * 处理端口已占用错误
   */
  async serverEADDRINUSE(err: any, isHttps: any) {
    return runtimeListen.serverEADDRINUSE(this as any, err, isHttps);
  }

  /**
   * 服务器加载完成
   */
  async serverLoad(isHttps: any) {
    return runtimeListen.serverLoad(this as any, isHttps);
  }

  /**
   * 启动代理服务器
   */
  async startProxyServers() {
    return runtimeProxy.startProxyServers(this as any);
  }

  /**
   * 加载HTTPS服务器
   * 支持HTTP/2和现代TLS配置
   */
  async httpsLoad() {
    return runtimeListen.httpsLoad(this as any);
  }

  /**
   * 设置最终处理器
   * 按照nginx风格：先处理API 404，再处理静态文件404
   */
  _setupFinalHandlers() {
    this.express.use(async (req: any, res: any) => {
      if (this._checkHeadersSent(res)) return;

      if (req.accepts('html')) {
        const staticRoot = req.staticRoot || paths.www;
        const custom404Path = path.join(staticRoot, '404.html');

        try {
          const st = await fs.stat(custom404Path);
          if (st.isFile()) {
            res.status(404).sendFile(custom404Path);
            return;
          }
        } catch {
          // 无自定义 404 页则走下方默认文案
        }

        res.status(404).send('404 Not Found');
      } else {
        res.status(404).json({
          error: '未找到',
          path: req.originalUrl || req.path,
          timestamp: Date.now(),
        });
      }
    });
    
    // 全局错误处理（捕获所有未处理的错误）
    this.express.use((err: any, req: any, res: any, next: any) => {
      if (this._checkHeadersSent(res, next, err)) return;

      if (runtimeConfig.server?.logging?.errors !== false) {
        RuntimeUtil.makeLog('error', `请求错误 [${req.requestId || 'unknown'}]: ${err.message}`, '服务器', err);
      }

      if (err?.name === 'MulterError') {
        const code = err.code || 'MULTER_ERROR';
        if (code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            error: '上传文件过大',
            message: '文件大小超过限制',
            requestId: req.requestId,
            timestamp: Date.now()
          });
        }
        if (code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({
            success: false,
            error: '上传文件数量过多',
            message: '文件数量超过限制',
            requestId: req.requestId,
            timestamp: Date.now()
          });
        }
      }

      // 统一使用 JSON 结构返回错误，避免基于路径做特殊分支
      res.status(err.status || 500).json({
        success: false,
        error: '内部服务器错误',
        message: process.env.NODE_ENV === 'production'
          ? '发生了一个错误' : err.message,
        requestId: req.requestId,
        timestamp: Date.now()
      });
    });
  }

  /**
   * 关闭服务器
   * @param {{ fast?: boolean }} [options] fast 为 true 时跳过固定等待（用于 Ctrl+C 重启）
   */
  async closeServer(options: any = {}) {
    return runtimeListen.closeServer(this as any, options);
  }

  /**
   * 获取服务器URL
   */
  getServerUrl() {
    return runtimeListen.getServerUrl(this as any);
  }

  /**
   * 获取对外可访问的服务器 URL（用于 QQ 直链等）
   * 不回落到 127.0.0.1；无公网/代理配置时返回空字符串
   * @param {string} [override=''] - 业务覆盖 public_base_url
   */
  getPublicServerUrl(override: any = '') {
    return runtimeNet.getPublicServerUrl(this as any, override);
  }

  /**
   * 获取本地IP地址
   */
  async getLocalIpAddress() {
    return runtimeNet.getLocalIpAddress(this as any);
  }

  /**
   * 主运行函数
   */
  async run(options: any = {}) {
    return runtimeBoot.runAgentRuntime(this as any, options);
  }


  /**
   * 准备事件对象（通用逻辑）
   * 只处理所有Tasker通用的属性，Tasker特定逻辑由插件通过accept方法处理
   * 
   * @param {Object} data - 事件数据对象
   */
  prepareEvent(data: any) {
    // 确保bot对象存在
    if (!data.bot && data.self_id && this.bots[data.self_id]) {
      Object.defineProperty(data, "bot", {
        value: this.bots[data.self_id],
        writable: false,
        configurable: false
      });
    }
    
    // 设置 tasker 信息（所有 tasker 通用）
    if (data.bot?.tasker?.id) {
      data.tasker_id = data.bot.tasker.id;
    }
    if (data.bot?.tasker?.name) {
      data.tasker_name = data.bot.tasker.name;
    }
    
    // 初始化基础sender对象（如果不存在）
    if (data.user_id && !data.sender) {
      data.sender = { user_id: data.user_id };
    }
    
    // 扩展事件方法（通用方法）
    this._extendEventMethods(data);
  }

  /**
   * 扩展事件方法（通用方法）
   * 为事件对象添加通用的辅助方法
   * @param {Object} data - 事件数据对象
   */
  _extendEventMethods(data: any) {
    if (!data.reply && data.bot?.sendMsg) {
      const botInstance = data.bot;
      const selfId = data.self_id;
      data.reply = async (msg = '', quote = false, extraData = {}) => {
        if (!msg) return false;
        try {
          return await botInstance.sendMsg(msg, quote, extraData);
        } catch (error: any) {
          RuntimeUtil.makeLog('error', `回复消息失败: ${error.message}`, selfId);
          return false;
        }
      };
    }
    
    if (!data.getRoutes) {
      data.getRoutes = (options = {}) => this.getRouteList(options);
    }
  }

  /**
   * 获取已注册的HTTP路由列表
   * @param {Object} options
   * @param {boolean} [options.flat=true] - 是否返回扁平数组
   * @returns {Array} 路由列表
   */
  getRouteList({ flat = true }: any = {}) {
    if (!HttpApiLoader?.apis) return [];
    
    const apiEntries = HttpApiLoader.priority?.length
      ? HttpApiLoader.priority
      : Array.from(HttpApiLoader.apis.values());
    
    const result = apiEntries.map((api: any) => {
      const apiName = api?.name || api?.key || 'undefined';
      const apiDesc = api?.dsc || apiName;
      const routes = Array.isArray(api?.routes) ? api.routes : [];
      
      return {
        api: apiName,
        dsc: apiDesc,
        routes: routes
          .filter((r: any) => r?.path && r?.method)
          .map((r: any) => ({
            api: apiName,
            method: String(r.method ?? '').toUpperCase(),
            path: r.path,
            name: r.name || r.id || '',
            desc: r.dsc || r.title || r.description || apiDesc
          }))
      };
    });
    
    if (!flat) return result;
    return result.flatMap(item => item.routes);
  }

  /**
   * 触发事件
   * @param {string} name - 事件名
   * @param {Object} data - 事件数据
   * @param {boolean} asJson - 是否等待stdin输出并返回JSON结果
   * @param {Object} options - 可选配置
   * @param {number} [options.timeout=5000] - 等待输出超时时间
   * @returns {Promise<*>|void}
   */
  async em(name: any = "", data: any = {}, asJson: any = false, options: any = {}) {
    this.prepareEvent(data);
    
    if (!asJson) {
      this._cascadeEmit(name, data);
      return;
    }
    
    const timeout = Number(options.timeout) || 5000;
    return await this._emitAndCollect(name, data, timeout);
  }
  
  
  /**
   * 供HTTP层调用的stdin命令封装
   * @param {string|Array|Object} command - 要执行的命令或消息
   * @param {Object} options
   * @param {Object} [options.user_info={}] - 用户信息
   * @param {number} [options.timeout=5000] - 等待输出超时时间
   * @returns {Promise<Object>} 命令结果或stdin输出
   */
  async callStdin(command: any, { user_info = {}, timeout = 5000 }: any = {}) {
    const stdinHandler = (getRuntimeGlobal('stdinHandler') as any);
    
    if (!stdinHandler?.processCommand) {
      throw this.makeError('stdin handler not initialized', 'StdinUnavailable');
    }

    const info = {
      ...user_info,
      tasker: user_info.tasker || 'api'
    }

    // 以“插件链路执行完成”为边界收集结果：由 PluginLoader.deal 在 finally 中回调 _onDone
    if (typeof stdinHandler.createEvent === 'function') {
      const event = stdinHandler.createEvent(command, info)

      const done = new Promise((resolve) => {
        event._onDone = resolve
      })

      this._cascadeEmit('stdin.message', event)

      const finishedEvent = await Promise.race([
        done,
        new Promise<any>((resolve) => setTimeout(() => resolve(event), timeout))
      ])

      // 优先返回结构化的插件结果（如果插件调用了 pushResult）
      const results = Array.isArray(finishedEvent?._pluginResults) ? finishedEvent._pluginResults : []

      // 同时将 reply() 过程中发送的消息聚合回传，便于 API 调试直接显示
      const outputs = Array.isArray(finishedEvent?._replyOutputs) ? finishedEvent._replyOutputs : []
      const content = outputs.flat().filter(Boolean)

      if (results.length) {
        return {
          event_id: finishedEvent.event_id,
          results,
          output: {
            nickname: 'stdin',
            content,
            user_info: info
          }
        }
      }

      // 没有 pushResult 时，兼容旧行为：返回聚合后的 stdout（如果有），否则回退基础结果
      if (content.length) {
        return { nickname: 'stdin', content, user_info: info }
      }
    }

    // 兜底：走原始 stdin 命令处理器
    return await stdinHandler.processCommand(command, info)
  }
  
  
  
  /**
   * 直接调用已注册的HTTP路由（内部快捷调用，无需额外HTTP客户端）
   * @param {string} routePath - 路由路径，如 /api/status
   * @param {Object} options
   * @param {string} [options.method='GET'] - HTTP方法
   * @param {Object} [options.query] - 查询参数
   * @param {any} [options.body] - 请求体（自动JSON序列化）
   * @param {Object} [options.headers] - 额外请求头
   * @param {string} [options.baseUrl] - 自定义基础URL，默认当前服务URL
   * @param {number} [options.timeout=5000] - 超时毫秒
   * @returns {Promise<Object>} 响应结果
   */
  async callRoute(routePath: any, {
    method = 'GET',
    query = {},
    body,
    headers = {},
    baseUrl,
    timeout = 5000
  }: any = {}) {
    if (!routePath) {
      throw this.makeError('routePath is required', 'RouteError');
    }
    
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      throw this.makeError('fetch is not available in current runtime', 'RouteError');
    }
    
    const url = new URL(routePath, baseUrl || this.getServerUrl());
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.append(k, String(v));
      }
    }
    
    const options: any = {
      method: String(method || 'GET').toUpperCase(),
      headers: { ...headers },
      signal: AbortSignal.timeout(timeout)
    };
    
    const needBody = !['GET', 'HEAD'].includes(options.method);
    if (needBody && body !== undefined) {
      if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer) {
        options.body = body;
      } else if (body instanceof URLSearchParams || body instanceof FormData) {
        options.body = body;
      } else {
        options.body = JSON.stringify(body);
        if (!options.headers['Content-Type'] && !options.headers['content-type']) {
          options.headers['Content-Type'] = 'application/json';
        }
      }
    }
    
    const response = await fetchFn(url, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
      raw: text
    };
  }
  
  _cascadeEmit(name: any, data: any) {
    while (name) {
      this.emit(name, data);
      const lastDot = name.lastIndexOf(".");
      if (lastDot === -1) break;
      name = name.slice(0, lastDot);
    }
  }
  
  async _emitAndCollect(name: any, data: any, timeout: any = 5000) {
    // 兼容历史行为：对“普通 emit”只提供一个有限的收集能力
    // 若调用方希望严格按插件链路结束收集，请走 callStdin（或在事件对象上设置 _onDone）
    const outputs: any[] = []
    const handler = (payload: any) => outputs.push(payload)

    this.on('stdin.output', handler)
    try {
      this._cascadeEmit(name, data)
      await RuntimeUtil.sleep(timeout)

      if (!outputs.length) return null
      if (outputs.length === 1) return outputs[0]

      const base = outputs[outputs.length - 1] || {}
      const allContent = outputs.flatMap(o => Array.isArray(o?.content) ? o.content : [])
      return { ...base, content: allContent }
    } finally {
      this.off('stdin.output', handler)
    }
  }

  /**
   * 发送消息给主人（通用函数）
   * 支持OneBot（通过pickFriend）和其他适配器
   */
  async sendMasterMsg(msg: any, sleep: any = 5000) {
    const masterQQs = runtimeConfig.masterQQ;
    const results: any = {};
    
    for (const [i, user_id] of masterQQs.entries()) {
      const pickFn = this.pickFriend || this.pickUser;
      const friend = pickFn.call(this, user_id);
      results[user_id] = await friend.sendMsg(msg);
      RuntimeUtil.makeLog("debug", `已发送消息给主人 ${user_id}`, '服务器');
      
      if (i < masterQQs.length - 1) await RuntimeUtil.sleep(sleep);
    }
    
    return results;
  }

  makeForwardMsg(msg: any) {
    return { type: "node", data: msg };
  }
  
  makeForwardArray(msg: any = [], node: any = {}) {
    return this.makeForwardMsg((Array.isArray(msg) ? msg : [msg]).map(message => ({ ...node, message })));
  }

  async sendForwardMsg(send: any, msg: any) {
    const messages = Array.isArray(msg) ? msg : [msg];
    return Promise.all(messages.map(({ message }) => send(message)));
  }

  /** stdin 等调试 bot：任意群号都能 pickGroup，不等于真有该群 */
  _isStdinBot(id: any, bot: any) {
    return (
      id === 'stdin' ||
      bot?.tasker_type === 'stdin' ||
      bot?.tasker?.id === 'stdin' ||
      /stdin|标准输入/i.test(String(bot?.tasker?.name || ''))
    );
  }

  _botHasGroup(bot: any, groupId: any) {
    const gl = bot?.gl;
    if (!gl || typeof gl.has !== 'function') return false;
    if (gl.has(groupId) || gl.has(String(groupId))) return true;
    const n = Number(groupId);
    return Number.isFinite(n) && gl.has(n);
  }

  /**
   * 按群号选 bot：谁 gl 里有该群就用谁；stdin 永不参与群路由
   * gl 未加载时，退回具备 tasker.sendGroupMsg 的非 stdin bot
   */
  _resolveBotForGroup(groupId: any) {
    const ids = Array.isArray(this.uin) ? [...this.uin] : Object.keys(this.bots || {});
    /** @type {object[]} */
    const owned = [];
    /** @type {object[]} */
    const canSend = [];

    for (const id of ids) {
      if (id == null || id === '') continue;
      const bot = this.bots?.[id];
      if (!bot || this._isStdinBot(id, bot)) continue;
      if (this._botHasGroup(bot, groupId)) owned.push(bot);
      if (typeof bot.tasker?.sendGroupMsg === 'function') canSend.push(bot);
    }

    return (
      owned.find((b) => typeof b.tasker?.sendGroupMsg === 'function') ||
      owned[0] ||
      canSend[0] ||
      null
    );
  }

  /**
   * 选择用于发送的 bot（无目标上下文时）
   * - 优先显式 botId
   * - 默认跳过 stdin（uin[0] 常为标准输入）
   */
  _getBotForSend(botId: any = null) {
    if (botId && this.bots?.[botId]) {
      return this.bots[botId];
    }

    const ids = Array.isArray(this.uin) ? [...this.uin] : [];
    for (const id of ids) {
      if (id == null || id === '') continue;
      const bot = this.bots?.[id];
      if (bot && !this._isStdinBot(id, bot)) return bot;
    }
    return null;
  }

  /**
   * 选取好友（兼容 OneBot / GSUID / QBQBot 等适配器）
   * - 当未指定 botId 时，自动选择一个可用的 AgentRuntime
   */
  pickFriend(user_id: any, botId: any = null) {
    const bot = this._getBotForSend(botId);
    if (!bot || typeof bot.pickFriend !== 'function') {
      throw new Error('当前没有可用的机器人，或不支持好友消息发送');
    }
    return bot.pickFriend(user_id);
  }

  /**
   * 选取群聊：未指定 botId 时按群号归属解析（stdin 不会因假 pickGroup 抢走）
   */
  pickGroup(group_id: any, botId: any = null) {
    const bot = (botId && this.bots?.[botId]) || this._resolveBotForGroup(group_id);
    if (!bot || typeof bot.pickGroup !== 'function') {
      throw new Error(`没有机器人可访问群 ${group_id}`);
    }
    return bot.pickGroup(group_id);
  }

  /**
   * 发送好友消息（供 HTTP 接口等统一调用）
   * @param {string} botId 机器人 UIN/self_id
   * @param {string|number} userId 好友 QQ / 用户 ID
   * @param {any} msg 消息内容（字符串或消息数组）
   * @returns {Promise<{message_id: string}>}
   */
  async sendFriendMsg(botId: any, userId: any, msg: any) {
    const bot = this._getBotForSend(botId);
    if (!bot) {
      throw new Error(`机器人不存在或未连接: ${botId || 'default'}`);
    }

    // 优先走各 tasker 提供的 sendFriendMsg 能力
    if (bot.tasker && typeof bot.tasker.sendFriendMsg === 'function') {
      const data = {
        self_id: bot.uin || bot.self_id || botId,
        bot,
        user_id: userId
      };
      return await bot.tasker.sendFriendMsg(data, msg);
    }

    // 兼容：通过 pickFriend().sendMsg 发送
    if (typeof bot.pickFriend === 'function') {
      const friend = bot.pickFriend(userId);
      if (friend && typeof friend.sendMsg === 'function') {
        return await friend.sendMsg(msg);
      }
    }

    throw new Error('当前机器人不支持好友消息发送');
  }

  /**
   * 发送群消息：未指定 botId 时按群号归属选 bot（谁有该群用谁）
   * @param {string|null} botId 机器人 UIN/self_id；null 则按 groupId 解析
   * @param {string|number} groupId 群号 / 目标 ID
   * @param {any} msg 消息内容（字符串或消息数组）
   * @returns {Promise<{message_id: string}>}
   */
  async sendGroupMsg(botId: any, groupId: any, msg: any) {
    const bot = (botId && this.bots?.[botId]) || this._resolveBotForGroup(groupId);
    if (!bot) {
      throw new Error(`没有机器人可发送到群 ${groupId}`);
    }

    // 优先走各 tasker 提供的 sendGroupMsg 能力
    if (bot.tasker && typeof bot.tasker.sendGroupMsg === 'function') {
      const data = {
        self_id: bot.uin || bot.self_id || botId,
        bot,
        group_id: groupId
      };
      return await bot.tasker.sendGroupMsg(data, msg);
    }

    // 兼容：通过 pickGroup().sendMsg 发送（stdin 等假实现不会在未指定 botId 时被选中）
    if (typeof bot.pickGroup === 'function') {
      const group = bot.pickGroup(groupId);
      if (group && typeof group.sendMsg === 'function') {
        return await group.sendMsg(msg);
      }
    }

    throw new Error('当前机器人不支持群消息发送');
  }

  async redisExit() {
    if (!(typeof (globalThis as any).redis === 'object' && (globalThis as any).redis?.process)) return false;
    
    const process = (globalThis as any).redis?.process;
    delete (globalThis as any).redis?.process;
    
    await RuntimeUtil.sleep(5000);
    return process.kill();
  }

}