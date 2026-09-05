// @ts-nocheck
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';
import LLMFactory from '#factory/llm/LLMFactory.js';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { mergeUniqueStrings } from '#utils/string-array-utils.js';

import { agtConfig } from './system/system-agt.js';
import { chatbotConfig } from './system/system-chatbot.js';
import { serverConfig } from './system/system-server.js';
import { deviceConfig } from './system/system-device.js';
import { redisConfig } from './system/system-redis.js';
import { sqliteConfig } from './system/system-sqlite.js';
import { aiWorkflowConfig } from './system/system-ai-workflow.js';
import { monitorConfig } from './system/system-monitor.js';
import { rendererConfig } from './system/system-renderer.js';

/**
 * 系统配置管理
 * - 全局：agt, device, monitor, redis, sqlite → server_bots/
 * - 随端口：server, chatbot, ai-workflow → server_bots/{port}/
 *   chatbot：主人/黑白名单/私聊 + 群默认与按群号覆盖
 */
export default class SystemConfig extends ConfigBase {
  constructor() {
    super({
      name: 'system',
      displayName: '系统配置',
      description: 'XRK-AGT 系统配置（agt/server/chatbot/ai-workflow 等子配置）',
      filePath: '',
      fileType: 'yaml'
    });

    this.configFiles = {
      agt: agtConfig,
      chatbot: chatbotConfig,
      server: serverConfig,
      device: deviceConfig,
      redis: redisConfig,
      sqlite: sqliteConfig,
      'ai-workflow': aiWorkflowConfig,
      monitor: monitorConfig,
      renderer: rendererConfig
    };

    // 构造时做一次动态 schema 刷新，后续通过 getStructure() 再按需更新
    this._refreshDynamicSchema();
  }

  /**
   * 获取指定配置文件的实例
   * @param {string} name - 配置名称
   * @returns {ConfigBase}
   */
  getConfigInstance(name) {
    const configMeta = this.configFiles[name];
    if (!configMeta) {
      throw new Error(`未知的配置: ${name}`);
    }

    const instance = new ConfigBase(configMeta);
    if (name === 'ai-workflow') {
      instance.prepareValidate = (data) => this._refreshDynamicSchema(data);
    }
    return instance;
  }

  /**
   * 读取指定配置文件
   * @param {string} [name] - 子配置名称（可选，如果不提供则返回配置列表）
   * @returns {Promise<Object>}
   */
  async read(name) {
    if (!name) {
      return {
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        configs: this.getConfigList()
      };
    }

    const instance = this.getConfigInstance(name);
    return await instance.read();
  }

  /**
   * 写入指定配置文件
   * @param {string} name - 子配置名称
   * @param {Object} data - 配置数据
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async write(name, data, options = {}) {
    if (!name) {
      throw new Error('SystemConfig 写入需要指定子配置名称');
    }
    const instance = this.getConfigInstance(name);
    return await instance.write(data, options);
  }

  /**
   * 获取指定配置的值
   * @param {string} name - 配置名称
   * @param {string} keyPath - 键路径
   * @returns {Promise<any>}
   */
  async get(name, keyPath) {
    const instance = this.getConfigInstance(name);
    return await instance.get(keyPath);
  }

  /**
   * 设置指定配置的值
   * @param {string} name - 配置名称
   * @param {string} keyPath - 键路径
   * @param {any} value - 新值
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async set(name, keyPath, value, options = {}) {
    const instance = this.getConfigInstance(name);
    return await instance.set(keyPath, value, options);
  }

  /**
   * 获取所有配置文件的结构
   * @returns {Object}
   */
  getStructure() {
    // 每次获取结构前动态刷新 schema（LLM Provider enum）
    this._refreshDynamicSchema();

    const structure = {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      configs: {}
    };

    for (const [name, meta] of Object.entries(this.configFiles)) {
      structure.configs[name] = {
        ...meta,
        fields: meta.schema?.fields || {}
      };
    }

    return structure;
  }

  /**
   * 获取配置列表（用于API）
   * @returns {Array}
   */
  getConfigList() {
    return Object.entries(this.configFiles).map(([name, meta]) => ({
      name,
      displayName: meta.displayName,
      description: meta.description,
      filePath: meta.filePath,
      fileType: meta.fileType
    }));
  }

  /**
   * 动态刷新 ai-workflow 相关 schema（LLM Provider）
   * @param {object} [validateSnapshot] - 待校验/写入的配置快照；用于把已持久化的值并入 enum，避免改无关字段时误伤校验
   */
  _refreshDynamicSchema(validateSnapshot = null) {
    try {
      const aiWorkflowSchema = this.configFiles?.['ai-workflow']?.schema?.fields;
      if (!aiWorkflowSchema) return;

      const snap = validateSnapshot || runtimeConfig?.aiWorkflow || {};
      this._refreshAiWorkflowLlmProviderEnum(aiWorkflowSchema.llm?.fields, snap);
    } catch (e) {
      RuntimeUtil.makeLog('error', `[SystemConfig] 刷新动态 schema 失败: ${e.message}`, 'SystemConfig');
    }
  }

  _refreshAiWorkflowLlmProviderEnum(llmFields, snap) {
    if (!llmFields?.Provider) return;

    let providers = [];
    try {
      providers = LLMFactory.listProviders?.() || [];
    } catch (e) {
      RuntimeUtil.makeLog('warn', `[SystemConfig] 获取 LLM Provider 列表失败: ${e.message}`, 'SystemConfig');
    }

    const currentProvider = String(snap?.llm?.Provider ?? snap?.llm?.provider ?? '').trim().toLowerCase();
    providers = mergeUniqueStrings(providers, currentProvider);

    if (providers.length) {
      llmFields.Provider.enum = providers;
      llmFields.Provider.component = 'Select';
      if (!llmFields.Provider.default || !providers.includes(llmFields.Provider.default)) {
        llmFields.Provider.default = providers[0];
      }
    } else {
      delete llmFields.Provider.enum;
      llmFields.Provider.component = 'Input';
    }
  }
}
