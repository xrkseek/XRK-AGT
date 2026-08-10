import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import paths from '#utils/paths.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { HotReloadBase } from '#utils/hot-reload-base.js';
import { normalizeError } from '#utils/normalize-error.js';
import { isShuttingDown } from '#utils/runtime-globals.js';
import { fileExistsSync, loadYamlFromCandidates, mergeYamlTexts, readYamlTextsBatch } from '#utils/config-yaml.js';
import { copyFileIfMissingSync } from './config-seed.js';
import { GLOBAL_CONFIGS, SERVER_CONFIGS, CHATBOT_FIXED_ROOT_KEYS } from './config-constants.js';
import { seedGlobalConfigsSync } from './config-seed.js';

const LOG_TAG = 'Config';
/** @type {Promise<typeof import('#infrastructure/renderer/loader.js')['default']>|null} */
let rendererLoaderPromise = null;

function getRendererLoader() {
  rendererLoaderPromise ??= import('#infrastructure/renderer/loader.js').then((m) => m.default);
  return rendererLoaderPromise;
}

/**
 * 配置管理类
 * 配置结构：
 * - 全局配置：存储在 server_bots/ 根目录
 * - 服务器配置：存储在 server_bots/{port}/
 */
class RuntimeConfig {
  config = {};
  _port = null;
  _configHotReload = null;
  /** @type {Map<string, string>} key -> 文件路径 */
  _hotReloads = new Map();
  /** @type {Map<string, { name: string, key: string }>} 文件路径 -> 变更元数据 */
  _watchHandlers = new Map();
  _renderer = null;
  _package = null;
  _watchEnabled = false;
  _deferredWatches = [];
  _destroying = false;

  PATHS = {
    DEFAULT_CONFIG: paths.configDefault,
    SERVER_BOTS: paths.dataServerBots,
    RENDERERS: paths.renderers
  };

  GLOBAL_CONFIGS = GLOBAL_CONFIGS;
  SERVER_CONFIGS = SERVER_CONFIGS;

  constructor() {
    const portIndex = process.argv.indexOf('server');
    if (portIndex !== -1 && process.argv[portIndex + 1]) {
      this._port = parseInt(process.argv[portIndex + 1]);
    }

    seedGlobalConfigsSync();
  }

  getGlobalConfigDir() {
    return this.PATHS.SERVER_BOTS;
  }

  getConfigDir() {
    if (!this._port || isNaN(this._port)) return null;
    return path.join(this.PATHS.SERVER_BOTS, String(this._port));
  }

  /** 一次性：旧键清理；工具面默认名单已废止（仅请求体 workflow.workflows） */
  normalizeAiWorkflowConfigShape(config) {
    if (!config || typeof config !== 'object') return config;
    const aw = config.agentWorkspace;
    if (aw && typeof aw === 'object' && aw.workflows == null && Array.isArray(aw.streams)) {
      aw.workflows = aw.streams;
      delete aw.streams;
    }
    const mcp = config.mcp;
    if (mcp && typeof mcp === 'object') {
      delete mcp.defaultStreams;
      delete mcp.defaultWorkflows;
      delete mcp.defaultRemoteMcp;
    }
    return config;
  }

  /** 一次性：server_bots 下 aistream.yaml → ai-workflow.yaml */
  migrateAistreamYamlOnce(configDir) {
    if (!configDir) return;
    const legacy = path.join(configDir, 'aistream.yaml');
    const next = path.join(configDir, 'ai-workflow.yaml');
    try {
      if (fileExistsSync(legacy) && !fileExistsSync(next)) {
        fs.renameSync(legacy, next);
        RuntimeUtil.makeLog('warn', `[配置迁移] aistream.yaml → ai-workflow.yaml (${configDir})`, LOG_TAG);
      }
    } catch (err) {
      RuntimeUtil.makeLog('warn', `[配置迁移] aistream→ai-workflow 失败: ${err?.message || err}`, LOG_TAG);
    }
  }


  getGlobalConfig(name) {
    const key = `global.${name}`;
    if (this.config[key]) return this.config[key];

    const file = path.join(this.getGlobalConfigDir(), `${name}.yaml`);
    const defaultFile = path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`);

    try {
      const { config, watchFile } = loadYamlFromCandidates([file, defaultFile], name);
      // 必须先写入缓存再 watch：watch 内 makeLog 会读 runtimeConfig.agt，否则会递归 getGlobalConfig
      this.config[key] = config;
      if (watchFile) this.watch(watchFile, name, key);
      return this.config[key];
    } catch (error) {
      RuntimeUtil.makeLog('error', `[配置解析失败][${name}] ${error?.message || error}`, LOG_TAG, true);
      return this.config[key] = {};
    }
  }

  getServerConfig(name) {
    if (this.GLOBAL_CONFIGS.includes(name)) {
      RuntimeUtil.makeLog('warn', `[配置警告] ${name} 是全局配置，应使用 getGlobalConfig() 或 runtimeConfig.${name} 访问`, LOG_TAG);
      return {};
    }
    
    const key = `server.${this._port}.${name}`;
    if (this.config[key]) return this.config[key];
    
    const configDir = this.getConfigDir();
    this.migrateAistreamYamlOnce(configDir);
    if (!configDir) {
      const defaultFile = path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`);
      try {
        const { config } = loadYamlFromCandidates([defaultFile], name);
        return config;
      } catch {
        return {};
      }
    }

    const file = path.join(configDir, `${name}.yaml`);
    const defaultFile = path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`);

    if (fileExistsSync(defaultFile) && copyFileIfMissingSync(defaultFile, file)) {
      RuntimeUtil.makeLog('mark', `[自动生成配置] ${name}.yaml -> ${file}`, LOG_TAG);
    }

    try {
      let { config, watchFile } = loadYamlFromCandidates([file], name);
      if (name === 'ai-workflow') config = this.normalizeAiWorkflowConfigShape(config);
      if (name === 'chatbot') config = this.ensureChatbotDefaults(config, defaultFile);
      this.config[key] = config;
      if (watchFile) this.watch(watchFile, name, key);
      return this.config[key];
    } catch (error) {
      RuntimeUtil.makeLog('error', `[服务器配置解析失败][${name}] ${error?.message || error}`, LOG_TAG, true);
      return this.config[key] = {};
    }
  }

  /**
   * chatbot 缺 default 时从模板补齐（不合并任何其它文件）
   * @private
   */
  ensureChatbotDefaults(config, defaultFile) {
    const out = config && typeof config === 'object' ? { ...config } : {};
    if (out.default && typeof out.default === 'object' && !Array.isArray(out.default)) {
      return out;
    }
    try {
      const { config: tpl } = loadYamlFromCandidates([defaultFile], 'chatbot');
      if (tpl?.default && typeof tpl.default === 'object') {
        out.default = structuredClone(tpl.default);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  getConfig(name) {
    return this.GLOBAL_CONFIGS.includes(name) 
      ? this.getGlobalConfig(name) 
      : this.getServerConfig(name);
  }

  get agt() { return this.getGlobalConfig('agt'); }
  get device() { return this.getGlobalConfig('device'); }
  get monitor() { return this.getGlobalConfig('monitor'); }
  get redis() { return this.getGlobalConfig('redis'); }
  get sqlite() { return this.getGlobalConfig('sqlite'); }
  // ai-workflow 为随端口配置（server_bots/{port}/ai-workflow.yaml）
  get aiWorkflow() { return this.getServerConfig('ai-workflow'); }
  /** 子服务端连接（host/port/timeout/runtimes）；AgentRuntime.callSubserver 读取 */
  get subserver() { return this.aiWorkflow?.subserver ?? {}; }

  get server() { return this.getServerConfig('server'); }
  get chatbot() { return this.getServerConfig('chatbot'); }

  get volcengine_llm() { return this.getServerConfig('volcengine_llm'); }
  get xiaomimimo_llm() { return this.getServerConfig('xiaomimimo_llm'); }
  get openai_llm() { return this.getServerConfig('openai_llm'); }
  get openai_compat_llm() { return this.getServerConfig('openai_compat_llm'); }
  get gemini_llm() { return this.getServerConfig('gemini_llm'); }
  get anthropic_llm() { return this.getServerConfig('anthropic_llm'); }
  get azure_openai_llm() { return this.getServerConfig('azure_openai_llm'); }
  get volcengine_asr() { return this.getServerConfig('volcengine_asr'); }
  get volcengine_tts() { return this.getServerConfig('volcengine_tts'); }

  get masterQQ() {
    const masterQQ = this.chatbot?.master?.qq || [];
    const list = Array.isArray(masterQQ) ? masterQQ : [masterQQ];
    return list.map(qq => {
      if (typeof qq === 'number') return qq;
      if (typeof qq === 'string' && /^\d+$/.test(qq)) return Number(qq);
      return qq;
    });
  }

  get master() {
    const masters = {};
    if (AgentRuntime.uin) {
      const masterList = this.masterQQ.map(qq => String(qq));
      AgentRuntime.uin.forEach(botUin => {
        masters[botUin] = masterList;
      });
    }
    return masters;
  }

  /**
   * 群生效配置 = chatbot.default ∪ 根级群号覆盖（固定键名不会当群号）
   */
  getGroup(groupId = '') {
    const config = this.chatbot || {};
    const defaultCfg =
      config.default && typeof config.default === 'object' && !Array.isArray(config.default)
        ? config.default
        : {};
    if (!groupId) return { ...defaultCfg };
    const id = String(groupId);
    if (CHATBOT_FIXED_ROOT_KEYS.includes(id)) return { ...defaultCfg };
    const override = config[id];
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return { ...defaultCfg };
    }
    return { ...defaultCfg, ...override };
  }

  getRendererConfig(type) {
    const defaultFile = path.join(this.PATHS.RENDERERS, type, 'config_default.yaml');
    if (!this._port) {
      try {
        const { config } = loadYamlFromCandidates([defaultFile], `renderer.${type}`);
        RuntimeUtil.makeLog('debug', `[渲染器] port 未设置，仅用默认配置: ${type}`, LOG_TAG);
        return config;
      } catch {
        return {};
      }
    }
    const key = `renderer.${this._port}.${type}`;
    if (this.config[key]) return this.config[key];
    const serverDir = path.join(this.getConfigDir(), 'renderers', type);
    const serverFile = path.join(serverDir, 'config.yaml');

    const texts = readYamlTextsBatch([defaultFile, serverFile]);
    const config = mergeYamlTexts(texts.get(defaultFile), texts.get(serverFile));

    this.config[key] = config;
    if (fileExistsSync(serverFile)) {
      this.watch(serverFile, `renderer.${type}`, key);
      RuntimeUtil.makeLog('debug', `[渲染器] 已合并 ${type} 服务器配置: ${serverFile}`, LOG_TAG);
    } else {
      RuntimeUtil.makeLog('debug', `[渲染器] 无服务器覆盖: ${serverFile}`, LOG_TAG);
    }
    return this.config[key];
  }

  /**
   * 启动期批量预热配置（减少首次 getter 的分散 I/O）
   */
  warmupConfigs() {
    const pathsToRead = [];
    for (const name of this.GLOBAL_CONFIGS) {
      pathsToRead.push(
        path.join(this.getGlobalConfigDir(), `${name}.yaml`),
        path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`)
      );
    }
    if (this._port && this.getConfigDir()) {
      const configDir = this.getConfigDir();
      for (const name of this.SERVER_CONFIGS) {
        pathsToRead.push(
          path.join(configDir, `${name}.yaml`),
          path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`)
        );
      }
    }
    readYamlTextsBatch(pathsToRead);
  }

  get renderer() {
    if (this._renderer) return this._renderer;
    return this._renderer = {
      puppeteer: this.getRendererConfig('puppeteer'),
      playwright: this.getRendererConfig('playwright')
    };
  }

  get port() {
    return this._port;
  }

  get package() {
    if (this._package) return this._package;
    return this._package = JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8'));
  }

  setConfig(name, data) {
    const isGlobal = this.GLOBAL_CONFIGS.includes(name);
    const configDir = isGlobal ? this.getGlobalConfigDir() : this.getConfigDir();
    if (!configDir) {
      RuntimeUtil.makeLog('error', '[配置保存失败] 无效的端口号', LOG_TAG);
      return false;
    }

    const file = path.join(configDir, `${name}.yaml`);
    const key = isGlobal ? `global.${name}` : `server.${this._port}.${name}`;
    const configType = isGlobal ? '全局' : '服务器';

    try {
      this.config[key] = data;
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(file, YAML.stringify(data), 'utf8');
      RuntimeUtil.makeLog('mark', `[保存${configType}配置文件][${name}]`, LOG_TAG);
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `[${configType}配置保存失败][${name}] ${error?.message || error}`, LOG_TAG, true);
      return false;
    }
  }

  watch(file, name, key) {
    if (this._destroying || isShuttingDown() || this._hotReloads.has(key)) return;

    if (!this._watchEnabled) {
      this._deferredWatches.push({ file, name, key });
      return;
    }

    this._attachWatch(file, name, key);
  }

  _attachWatch(file, name, key) {
    const resolved = HotReloadBase.resolveWatchPath(file);
    this._hotReloads.set(key, resolved);
    this._watchHandlers.set(resolved, { name, key });

    if (!this._configHotReload) {
      const hotReload = new HotReloadBase({ loggerName: LOG_TAG });
      this._configHotReload = hotReload;
      void hotReload.watch(true, {
        files: [resolved],
        shouldHandle: () => true,
        invalidateCoreCacheOnAdd: false,
        onChange: (changedFile) => this._handleConfigChange(changedFile)
      }).then((ok) => {
        if (ok) return;
        if (this._configHotReload === hotReload) {
          this._configHotReload = null;
        }
        this._rollbackWatch(key, resolved);
        RuntimeUtil.makeLog('warn', `[配置文件监视启动失败][${name}] ${resolved}`, LOG_TAG);
      });
      return;
    }

    if (!this._configHotReload.addTargets(resolved)) {
      this._rollbackWatch(key, resolved);
      RuntimeUtil.makeLog('warn', `[配置文件监视追加失败][${name}] ${resolved}`, LOG_TAG);
    }
  }

  _rollbackWatch(key, resolved) {
    this._hotReloads.delete(key);
    this._watchHandlers.delete(resolved);
  }

  async _handleConfigChange(changedFile) {
    const meta = this._watchHandlers.get(HotReloadBase.resolveWatchPath(changedFile));
    if (!meta || this._destroying) return;

    const { name, key } = meta;
    try {
      delete this.config[key];
      if (key.startsWith('renderer.')) {
        this._renderer = null;
        const type = key.split('.').pop();
        await getRendererLoader().then((loader) => loader.reloadRenderer(type));
      }
      RuntimeUtil.makeLog('mark', `[修改配置文件][${name}]`, LOG_TAG);
      const handler = this[`change_${name}`];
      if (handler) await handler();
    } catch (err) {
      const error = normalizeError(err);
      RuntimeUtil.makeLog('error', `[配置热更新失败][${name}] ${error.message}`, LOG_TAG, error);
    }
  }

  enableWatching() {
    if (this._watchEnabled || this._destroying || isShuttingDown()) return;
    this._watchEnabled = true;
    const pending = this._deferredWatches.splice(0);
    for (const { file, name, key } of pending) {
      this.watch(file, name, key);
    }
  }

  async change_agt() {
    try {
      const log = await import('#infrastructure/log.js');
      log.default();
    } catch (error) {
      RuntimeUtil.makeLog('error', `[AGT配置变更处理失败] ${error?.message || error}`, LOG_TAG, true);
    }
  }

  async destroy() {
    if (this._destroying) return;
    this._destroying = true;
    this._deferredWatches.length = 0;
    await this._configHotReload?.stop().catch(() => {});
    this._configHotReload = null;
    this._hotReloads.clear();
    this._watchHandlers.clear();
    this.config = {};
    this._renderer = null;
  }
}

export default new RuntimeConfig();
