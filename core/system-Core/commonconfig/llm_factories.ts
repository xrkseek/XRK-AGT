// @ts-nocheck
import ConfigBase from '#infrastructure/commonconfig/commonconfig.js';
import { llmFactoryConfigFiles } from './shared/llm-factory-registry.js';

/**
 * AI LLM 工厂（多文件）：侧栏一项，子配置为各 *_llm.yaml。
 * 写法见 shared/llm-factory-meta.js · defineLlmFactoryMeta。
 */
export default class LlmFactoriesConfig extends ConfigBase {
  constructor() {
    super({
      name: 'llm_factories',
      displayName: 'AI LLM 工厂',
      description: '各厂商 / 兼容协议工厂；子配置对应 data/server_bots/{port}/*_llm.yaml',
      filePath: '',
      fileType: 'yaml',
    });
    this.configFiles = llmFactoryConfigFiles();
  }

  getConfigInstance(name) {
    const configMeta = this.configFiles[name];
    if (!configMeta) throw new Error(`未知的 LLM 工厂: ${name}`);
    return new ConfigBase(configMeta);
  }

  async read(name) {
    if (!name) {
      return {
        name: this.name,
        displayName: this.displayName,
        description: this.description,
        configs: this.getConfigList(),
      };
    }
    return this.getConfigInstance(name).read();
  }

  async write(name, data, options = {}) {
    if (!name) throw new Error('llm_factories 写入需要指定子配置名称');
    return this.getConfigInstance(name).write(data, options);
  }

  async get(name, keyPath) {
    return this.getConfigInstance(name).get(keyPath);
  }

  async set(name, keyPath, value, options = {}) {
    return this.getConfigInstance(name).set(keyPath, value, options);
  }

  getStructure() {
    const structure = {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      configs: {},
    };
    for (const [name, meta] of Object.entries(this.configFiles)) {
      structure.configs[name] = {
        ...meta,
        fields: meta.schema?.fields || {},
      };
    }
    return structure;
  }

  getConfigList() {
    return Object.entries(this.configFiles).map(([name, meta]) => ({
      name,
      displayName: meta.displayName,
      description: meta.description,
      filePath: meta.filePath,
      fileType: meta.fileType,
    }));
  }
}
