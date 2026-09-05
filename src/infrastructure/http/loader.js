import path from 'node:path';
import HttpApi from './http.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import paths from '#utils/paths.js';
import { validateApiInstance, getApiPriority } from './utils/helpers.js';
import { FileLoader } from '#utils/file-loader.js';
import { resolveCoreModuleKey, resolveQualifiedCoreModuleKey } from '#utils/core-fs.js';
import { API_REGISTER_BATCH_SIZE, LOADER_BATCH_SIZE } from '#utils/loader-constants.js';
import { classifyModuleImportError } from '#utils/module-import-error.js';

class HttpApiLoader {
  apis = new Map();
  priority = [];
  loaded = false;
  app = null;
  bot = null;
  _httpDirsCache = null;

  async load() {
    const startTime = Date.now();
    RuntimeUtil.makeLog('info', '开始加载API模块...', 'HttpApiLoader');

    const allFiles = await FileLoader.getCoreSubDirFiles('http', {
      recursive: true
    });

    this._httpDirsCache = await paths.getCoreSubDirs('http');
    await FileLoader.forEachBatch(allFiles, LOADER_BATCH_SIZE, (file) => this.loadApi(file));
    this._httpDirsCache = null;

    this.sortByPriority();
    this.loaded = true;
    RuntimeUtil.makeLog('info', `API模块加载完成: ${this.apis.size}个, 耗时${Date.now() - startTime}ms`, 'HttpApiLoader');
    return this.apis;
  }

  async getApiKey(filePath) {
    const httpDirs = this._httpDirsCache ?? await paths.getCoreSubDirs('http');
    return resolveQualifiedCoreModuleKey(filePath, httpDirs, 'http');
  }

  async loadApi(filePath) {
    try {
      const key = await this.getApiKey(filePath);
      if (this.apis.has(key)) await this.unloadApi(key);

      const module = await FileLoader.importFresh(filePath);
      if (!module.default) {
        const namedExports = Object.keys(module).filter((k) => k !== 'default');
        if (namedExports.length > 0) {
          RuntimeUtil.makeLog('debug', `跳过非 API 文件: ${key}`, 'HttpApiLoader');
          return false;
        }
        RuntimeUtil.makeLog('warn', `无效 API 模块: ${key}`, 'HttpApiLoader');
        return false;
      }

      let apiInstance;
      if (typeof module.default === 'function') {
        apiInstance = new module.default();
      } else if (typeof module.default === 'object') {
        apiInstance = new HttpApi(module.default);
      } else {
        RuntimeUtil.makeLog('warn', `无效 API 模块: ${key}`, 'HttpApiLoader');
        return false;
      }

      validateApiInstance(apiInstance, key);
      if (typeof apiInstance.getInfo !== 'function') {
        apiInstance.getInfo = function () {
          return {
            name: this.name,
            dsc: this.dsc,
            priority: getApiPriority(this),
            routes: this.routes.length,
            enable: this.enable !== false,
            createTime: this.createTime ?? Date.now()
          };
        };
      }

      apiInstance.key = key;
      apiInstance.filePath = filePath;
      this.apis.set(key, apiInstance);
      return true;
    } catch (error) {
      const classified = classifyModuleImportError(error);
      let detail = error.message;
      if (classified.kind === 'missing_export') {
        detail = `模块未导出 ${classified.exportName}（Runtime database 仅 Redis；Mongo/PG/Vector 请用对应 Core）`;
      } else if (classified.kind === 'missing_package') {
        detail = `缺少依赖 ${classified.packageName || '未知'}，请 pnpm add 后重启`;
      } else if (classified.kind === 'missing_file') {
        detail = `缺少本地模块 ${classified.filePath || '未知'}（检查路径或未提交文件）`;
      }
      RuntimeUtil.makeLog('error', `加载API失败: ${filePath} - ${detail}`, 'HttpApiLoader', error);
      return false;
    }
  }

  async unloadApi(key) {
    const api = this.apis.get(key);
    if (!api) return;

    if (typeof api.stop === 'function') {
      try {
        await api.stop();
      } catch (error) {
        RuntimeUtil.makeLog('warn', `卸载 API stop 失败: ${api.name} - ${error.message}`, 'HttpApiLoader');
      }
    }

    this._removeWsHandlersByOwner(key);
    this.apis.delete(key);
    RuntimeUtil.makeLog('debug', `卸载API: ${api.name}`, 'HttpApiLoader');
  }

  _removeWsHandlersByOwner(ownerKey) {
    if (!this.bot?.wsf) return;
    for (const [wsPath, handlers] of Object.entries(this.bot.wsf)) {
      if (!Array.isArray(handlers)) continue;
      const filtered = handlers.filter((fn) => fn.__ownerKey !== ownerKey);
      if (filtered.length > 0) this.bot.wsf[wsPath] = filtered;
      else delete this.bot.wsf[wsPath];
    }
  }

  sortByPriority() {
    this.priority = [...this.apis.values()]
      .filter((api) => api.enable !== false)
      .sort((a, b) => getApiPriority(b) - getApiPriority(a));
  }

  async _initApi(api) {
    if (this.app && this.bot && typeof api.init === 'function') {
      await api.init(this.app, this.bot);
    }
  }

  async _reloadFromFile(key, filePath) {
    await this.unloadApi(key);
    await this.loadApi(filePath);
    this.sortByPriority();
    await this._initApi(this.apis.get(key));
  }

  async register(app, bot) {
    this.app = app;
    this.bot = bot;

    app.use((req, res, next) => {
      req.agentRuntime = bot;
      req.apiLoader = this;
      next();
    });

    let totalRoutes = 0;
    let totalWS = 0;
    let enabledCount = 0;

    const registerOne = async (api) => {
      try {
        const routeCount = api.routes.length;
        const wsCount = api.wsHandlers ? Object.keys(api.wsHandlers).length : 0;
        await this._initApi(api);

        if (routeCount > 0 || wsCount > 0) {
          if (getAiWorkflowConfigOptional().global?.debug) {
            RuntimeUtil.makeLog('debug', `注册API: ${api.name} (路由: ${routeCount}, WS: ${wsCount})`, 'HttpApiLoader');
          }
          return { routeCount, wsCount, enabled: true };
        }
        return { routeCount: 0, wsCount: 0, enabled: false };
      } catch (error) {
        RuntimeUtil.makeLog('error', `注册API失败: ${api.name} - ${error.message}`, 'HttpApiLoader', error);
        return { routeCount: 0, wsCount: 0, enabled: false };
      }
    };

    const results = await FileLoader.mapInBatches(this.priority, API_REGISTER_BATCH_SIZE, registerOne);
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value.enabled) continue;
      totalRoutes += result.value.routeCount;
      totalWS += result.value.wsCount;
      enabledCount++;
    }

    app.use('/api/*', (req, res, next) => {
      if (req.path.startsWith('/api/god/')) return next();
      if (!res.headersSent) {
        res.status(404).json({
          success: false,
          message: 'API endpoint not found',
          path: req.originalUrl,
          timestamp: Date.now()
        });
      }
    });

    RuntimeUtil.makeLog('info', `API路由注册完成: ${enabledCount}个模块, ${totalRoutes}个路由, ${totalWS}个WebSocket`, 'HttpApiLoader');
  }

  async changeApi(key, filePath = null) {
    const api = this.apis.get(key);
    const resolved = filePath ?? api?.filePath ?? await this._findApiFile(key);
    if (!resolved) {
      RuntimeUtil.makeLog('warn', `API不存在: ${key}`, 'HttpApiLoader');
      return false;
    }

    try {
      RuntimeUtil.makeLog('info', `重载API: ${api?.name ?? key}`, 'HttpApiLoader');
      await this._reloadFromFile(key, resolved);
      RuntimeUtil.makeLog('info', `API重载成功: ${this.apis.get(key)?.name ?? key}`, 'HttpApiLoader');
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `API重载失败: ${key}`, 'HttpApiLoader', error);
      return false;
    }
  }

  async _findApiFile(key) {
    const apiDirs = await paths.getCoreSubDirs('http');
    for (const apiDir of apiDirs) {
      const files = await FileLoader.readFiles(apiDir, { recursive: true });
      const file = files.find((f) => resolveQualifiedCoreModuleKey(f, [apiDir], 'http') === key);
      if (file) return file;
    }
    return null;
  }

  getApiList() {
    return [...this.apis.values()].map((api) => api.getInfo());
  }

  getApi(key) {
    return this.apis.get(key) ?? null;
  }
}

export default new HttpApiLoader();
