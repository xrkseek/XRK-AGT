import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import paths from '#utils/paths.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { fileExistsSync, loadYamlFromCandidates, mergeYamlTexts, readYamlTextsBatch } from '#utils/config-yaml.js';
import { copyFileIfMissingSync } from './config-seed.js';
import {
  GLOBAL_CONFIGS,
  SERVER_CONFIGS,
  isChatbotFixedRootKey,
  isGlobalConfig,
} from './config-constants.js';
import { seedGlobalConfigsSync } from './config-seed.js';
import { normalizeError } from '#utils/normalize-error.js';
import { getRuntimeGlobal } from '#utils/runtime-globals.js';

const LOG_TAG = 'Config';

/** any 值面：避免 `doc.foo || {}` 在 unknown 下塌成字面量 `{}`（TS2339） */
type YamlDoc = Record<string, any>;

function asYamlDoc(value: unknown): YamlDoc {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as YamlDoc) : {};
}

function errMsg(err: unknown): string {
  return normalizeError(err).message;
}

type RendererBundle = {
  puppeteer: YamlDoc;
  playwright: YamlDoc;
};

type AgentRuntimeMasters = {
  uin?: Array<string | number>;
};

/**
 * 配置管理类
 * 配置结构：
 * - 全局配置：存储在 server_bots/ 根目录
 * - 服务器配置：存储在 server_bots/{port}/
 *
 * 产品 CommonConfig 在 `CommonConfigRegistry.load()` 完成前不可用；
 * 构造期只 seed 全局 YAML。`warmupConfigs()` 应在 CommonConfig 加载之后调用。
 */
class RuntimeConfig {
  config: Record<string, YamlDoc> = {};
  _port: number | null = null;
  _renderer: RendererBundle | null = null;
  _package: YamlDoc | null = null;
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
  normalizeAiWorkflowConfigShape(config: unknown): unknown {
    if (!config || typeof config !== 'object') return config;
    const doc = config as YamlDoc;
    const aw = doc.agentWorkspace;
    if (aw && typeof aw === 'object' && !Array.isArray(aw)) {
      const workspace = aw as YamlDoc;
      if (workspace.workflows == null && Array.isArray(workspace.streams)) {
        workspace.workflows = workspace.streams;
        delete workspace.streams;
      }
    }
    const mcp = doc.mcp;
    if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
      const mcpDoc = mcp as YamlDoc;
      delete mcpDoc.defaultStreams;
      delete mcpDoc.defaultWorkflows;
      delete mcpDoc.defaultRemoteMcp;
    }
    return config;
  }

  /** 一次性：server_bots 下 aistream.yaml → ai-workflow.yaml */
  migrateAistreamYamlOnce(configDir: string | null) {
    if (!configDir) return;
    const legacy = path.join(configDir, 'aistream.yaml');
    const next = path.join(configDir, 'ai-workflow.yaml');
    try {
      if (fileExistsSync(legacy) && !fileExistsSync(next)) {
        fs.renameSync(legacy, next);
        RuntimeUtil.makeLog('warn', `[配置迁移] aistream.yaml → ai-workflow.yaml (${configDir})`, LOG_TAG);
      }
    } catch (err) {
      RuntimeUtil.makeLog('warn', `[配置迁移] aistream→ai-workflow 失败: ${errMsg(err)}`, LOG_TAG);
    }
  }


  getGlobalConfig(name: string): YamlDoc {
    const key = `global.${name}`;
    if (this.config[key]) return this.config[key];

    const file = path.join(this.getGlobalConfigDir(), `${name}.yaml`);
    const defaultFile = path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`);

    try {
      const { config } = loadYamlFromCandidates([file, defaultFile], name);
      // 必须先写入缓存：makeLog 会读 runtimeConfig.agt，否则会递归 getGlobalConfig
      this.config[key] = asYamlDoc(config);
      return this.config[key];
    } catch (error) {
      RuntimeUtil.makeLog('error', `[配置解析失败][${name}] ${errMsg(error)}`, LOG_TAG, true);
      return this.config[key] = {};
    }
  }

  getServerConfig(name: string): YamlDoc {
    if (isGlobalConfig(name)) {
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
        return asYamlDoc(config);
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
      let { config } = loadYamlFromCandidates([file], name);
      if (name === 'ai-workflow') config = this.normalizeAiWorkflowConfigShape(config) as object;
      if (name === 'chatbot') config = this.ensureChatbotDefaults(config, defaultFile);
      this.config[key] = asYamlDoc(config);
      return this.config[key];
    } catch (error) {
      RuntimeUtil.makeLog('error', `[服务器配置解析失败][${name}] ${errMsg(error)}`, LOG_TAG, true);
      return this.config[key] = {};
    }
  }

  /**
   * chatbot 缺 default 时从模板补齐（不合并任何其它文件）
   * @private
   */
  ensureChatbotDefaults(config: unknown, defaultFile: string): YamlDoc {
    const out = config && typeof config === 'object' ? { ...(config as YamlDoc) } : {};
    if (out.default && typeof out.default === 'object' && !Array.isArray(out.default)) {
      return out;
    }
    try {
      const { config: tpl } = loadYamlFromCandidates([defaultFile], 'chatbot');
      const template = asYamlDoc(tpl);
      if (template.default && typeof template.default === 'object') {
        out.default = structuredClone(template.default);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  getConfig(name: string): YamlDoc {
    return isGlobalConfig(name)
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
    const chatbot = this.chatbot;
    const master = asYamlDoc(chatbot.master);
    const masterQQ = master.qq ?? [];
    const list = Array.isArray(masterQQ) ? masterQQ : [masterQQ];
    return list.map((qq) => {
      if (typeof qq === 'number') return qq;
      if (typeof qq === 'string' && /^\d+$/.test(qq)) return Number(qq);
      return qq;
    });
  }

  get master() {
    const masters: Record<string, string[]> = {};
    const AgentRuntime = getRuntimeGlobal<AgentRuntimeMasters>('AgentRuntime');
    if (AgentRuntime?.uin) {
      const masterList = this.masterQQ.map((qq) => String(qq));
      for (const botUin of AgentRuntime.uin) {
        masters[String(botUin)] = masterList;
      }
    }
    return masters;
  }

  /**
   * 群生效配置 = chatbot.default ∪ 根级群号覆盖（固定键名不会当群号）
   */
  getGroup(groupId: string | number = '') {
    const config = this.chatbot || {};
    const defaultCfg =
      config.default && typeof config.default === 'object' && !Array.isArray(config.default)
        ? asYamlDoc(config.default)
        : {};
    if (!groupId) return { ...defaultCfg };
    const id = String(groupId);
    if (isChatbotFixedRootKey(id)) return { ...defaultCfg };
    const override = config[id];
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return { ...defaultCfg };
    }
    return { ...defaultCfg, ...asYamlDoc(override) };
  }

  getRendererConfig(type: string): YamlDoc {
    const defaultFile = path.join(this.PATHS.RENDERERS, type, 'config_default.yaml');
    if (!this._port) {
      try {
        const { config } = loadYamlFromCandidates([defaultFile], `renderer.${type}`);
        RuntimeUtil.makeLog('debug', `[渲染器] port 未设置，仅用默认配置: ${type}`, LOG_TAG);
        return asYamlDoc(config);
      } catch {
        return {};
      }
    }
    const key = `renderer.${this._port}.${type}`;
    if (this.config[key]) return this.config[key];
    const serverDir = path.join(this.getConfigDir() as string, 'renderers', type);
    const serverFile = path.join(serverDir, 'config.yaml');

    const texts = readYamlTextsBatch([defaultFile, serverFile]);
    const config = asYamlDoc(mergeYamlTexts(texts.get(defaultFile), texts.get(serverFile)));

    this.config[key] = config;
    if (fileExistsSync(serverFile)) {
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
    const pathsToRead: string[] = [];
    for (const name of this.GLOBAL_CONFIGS) {
      pathsToRead.push(
        path.join(this.getGlobalConfigDir(), `${name}.yaml`),
        path.join(this.PATHS.DEFAULT_CONFIG, `${name}.yaml`)
      );
    }
    if (this._port && this.getConfigDir()) {
      const configDir = this.getConfigDir()!;
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
    return this._package = asYamlDoc(JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8')));
  }

  setConfig(name: string, data: unknown) {
    const isGlobal = isGlobalConfig(name);
    const configDir = isGlobal ? this.getGlobalConfigDir() : this.getConfigDir();
    if (!configDir) {
      RuntimeUtil.makeLog('error', '[配置保存失败] 无效的端口号', LOG_TAG);
      return false;
    }

    const file = path.join(configDir, `${name}.yaml`);
    const key = isGlobal ? `global.${name}` : `server.${this._port}.${name}`;
    const configType = isGlobal ? '全局' : '服务器';

    try {
      this.config[key] = asYamlDoc(data);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(file, YAML.stringify(data), 'utf8');
      RuntimeUtil.makeLog('mark', `[保存${configType}配置文件][${name}]`, LOG_TAG);
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `[${configType}配置保存失败][${name}] ${errMsg(error)}`, LOG_TAG, true);
      return false;
    }
  }

  async change_agt() {
    try {
      const log = await import('#infrastructure/log.js');
      log.default();
    } catch (error) {
      RuntimeUtil.makeLog('error', `[AGT配置变更处理失败] ${errMsg(error)}`, LOG_TAG, true);
    }
  }

  async destroy() {
    if (this._destroying) return;
    this._destroying = true;
    this.config = {};
    this._renderer = null;
  }
}

export default new RuntimeConfig();
