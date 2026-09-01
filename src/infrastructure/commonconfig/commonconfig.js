import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import paths from '#utils/paths.js';

/**
 * 配置文件管理基类
 * 
 * 提供统一的配置文件读写接口，支持YAML和JSON格式。
 * 支持动态路径、缓存、备份、验证等功能。
 * 
 * @abstract
 * @class ConfigBase
 * @example
 * // 继承ConfigBase创建自定义配置类
 * class MyConfig extends ConfigBase {
 *   constructor() {
 *     super({
 *       name: 'myconfig',
 *       displayName: '我的配置',
 *       description: '自定义配置示例',
 *       filePath: 'config/myconfig.yaml',
 *       fileType: 'yaml',
 *       schema: { /* 配置结构定义 *\/ }
 *     });
 *   }
 * }
 * 
 * // 使用
 * const config = new MyConfig();
 * const data = await config.read();
 * await config.write({ key: 'value' });
 */
export default class ConfigBase {
  _cache = null;
  _cacheTime = 0;
  _cacheTTL = 5000;

  /**
   * 构造函数
   * 
   * @param {Object} metadata - 配置元数据
   * @param {string} metadata.name - 配置名称（用于标识，必填）
   * @param {string} metadata.displayName - 显示名称（用于UI显示）
   * @param {string} metadata.description - 配置描述
   * @param {string|Function} metadata.filePath - 配置文件相对路径或动态路径函数
   *   - 字符串：相对于项目根目录的路径，如 'config/myconfig.yaml'
   *   - 函数：动态计算路径，接收runtimeConfig对象，返回路径字符串
   * @param {string} metadata.fileType - 文件类型：'yaml' 或 'json'（默认'yaml'）
   * @param {Object} metadata.schema - 配置结构定义（用于验证）
   */
  constructor(metadata = {}) {
    this.name = metadata.name ?? 'config';
    this.displayName = metadata.displayName ?? this.name;
    this.description = metadata.description ?? '';
    this.filePath = metadata.filePath ?? '';
    this.defaultTemplatePath = metadata.defaultTemplatePath ?? '';
    this.fileType = metadata.fileType ?? 'yaml';
    this.schema = metadata.schema ?? {};
    // 多文件配置支持：用于处理一个配置包含多个文件的情况（如renderer包含puppeteer和playwright）
    this.multiFile = metadata.multiFile ?? null;

    // 严格校验：在构造阶段即校验 schema 的默认值与类型一致性，避免运行期回退逻辑
    this._assertSchemaStrict(this.schema);
    
    // 如果 filePath 是函数，则动态计算路径
    if (typeof this.filePath === 'function') {
      this._getFilePath = this.filePath;
    } else if (this.filePath) {
      // 完整文件路径
      this.fullPath = path.join(paths.root, this.filePath);
    } else {
      this.fullPath = undefined;
    }

    if (this.defaultTemplatePath) {
      this._defaultTemplateFullPath = path.isAbsolute(this.defaultTemplatePath)
        ? this.defaultTemplatePath
        : path.join(paths.root, this.defaultTemplatePath);
    } else {
      this._defaultTemplateFullPath = undefined;
    }
  }

  /** @returns {string[]} 读取缺省文件时的模板候选（按优先级） */
  _defaultTemplateCandidates() {
    const candidates = [];
    if (this._defaultTemplateFullPath) candidates.push(this._defaultTemplateFullPath);
    candidates.push(path.join(paths.root, 'config', 'default_config', `${this.name}.yaml`));
    return candidates;
  }

  /**
   * 严格校验 schema：
   * - 确保每个字段的 default 类型与 type 一致（若提供）
   * - enum 与 default 规则同 `_enumValueAllowed`（非必填允许 `''`）
   * - array 的 itemType 与 default 数组元素类型一致（若提供）
   * - object 的 fields 递归校验
   */
  _assertSchemaStrict(schema) {
    if (!schema?.fields) return;
    const check = (fields) => {
      for (const [key, fs] of Object.entries(fields)) {
        // 校验 default 与 type
        if (fs.default !== undefined) {
          const def = fs.default;
          const t = fs.type;
          if (t === 'number' && typeof def !== 'number') {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须为 number`);
          }
          if (t === 'string' && typeof def !== 'string') {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须为 string`);
          }
          if (t === 'boolean' && typeof def !== 'boolean') {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须为 boolean`);
          }
          if (t === 'array' && !Array.isArray(def)) {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须为 array`);
          }
          if (t === 'object' && (typeof def !== 'object' || Array.isArray(def))) {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须为 object`);
          }
        }
        // 校验 enum 与 default（与运行时 validate 同一规则）
        if (fs.enum && fs.default !== undefined) {
          const def = fs.default;
          if (fs.type === 'array' && Array.isArray(def)) {
            for (const v of def) {
              if (!this._enumValueAllowed(v, fs)) {
                throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 中的值 "${v}" 必须属于 enum: ${fs.enum.join(', ')}`);
              }
            }
          } else if (!this._enumValueAllowed(def, fs)) {
            throw new Error(`配置(${this.name}).schema 字段 ${key} 的 default 必须属于 enum: ${fs.enum.join(', ')}`);
          }
        }
        // 校验 array 元素类型
        if (fs.type === 'array' && fs.itemType && Array.isArray(fs.default)) {
          for (const [i, v] of fs.default.entries()) {
            if (fs.itemType === 'number' && typeof v !== 'number') throw new Error(`配置(${this.name}).schema 字段 ${key}[${i}] 必须为 number`);
            if (fs.itemType === 'string' && typeof v !== 'string') throw new Error(`配置(${this.name}).schema 字段 ${key}[${i}] 必须为 string`);
            if (fs.itemType === 'boolean' && typeof v !== 'boolean') throw new Error(`配置(${this.name}).schema 字段 ${key}[${i}] 必须为 boolean`);
            if (fs.itemType === 'object' && (typeof v !== 'object' || Array.isArray(v))) throw new Error(`配置(${this.name}).schema 字段 ${key}[${i}] 必须为 object`);
          }
        }
        // 递归校验 object 子字段
        if (fs.type === 'object' && fs.fields) {
          check(fs.fields);
        }
        // 递归校验 array 中的对象 itemSchema
        if (fs.type === 'array' && fs.itemType === 'object' && fs.itemSchema?.fields) {
          check(fs.itemSchema.fields);
        }
      }
    };
    check(schema.fields);
  }
  
  /**
   * 获取配置文件的完整路径（支持动态路径）
   * @returns {string}
   */
  _resolveFilePath() {
    if (this._getFilePath) {
      const dynamicPath = this._getFilePath(runtimeConfig);
      if (!dynamicPath) {
        throw new Error('动态路径函数未返回有效路径');
      }
      return path.join(paths.root, dynamicPath);
    }
    // 如果没有 fullPath，则认为未正确配置
    if (!this.fullPath) {
      throw new Error(`未指定配置文件路径: ${this.name}`);
    }
    return this.fullPath;
  }

  /**
   * 获取配置文件的完整路径
   * @returns {string}
   */
  getFilePath() {
    return this._resolveFilePath();
  }

  /**
   * 检查文件是否存在
   * @returns {Promise<boolean>}
   */
  async exists() {
    // 多文件配置：检查至少一个文件存在
    if (this.multiFile) {
      const { keys, getFilePath, getDefaultFilePath } = this.multiFile;
      for (const key of keys) {
        const filePath = getFilePath(key);
        try {
          await fs.access(filePath);
          return true;
        } catch {
          // 继续检查下一个
        }
      }
      // 检查默认文件
      if (getDefaultFilePath) {
        for (const key of keys) {
          const defaultFilePath = getDefaultFilePath(key);
          if (defaultFilePath && fsSync.existsSync(defaultFilePath)) {
            return true;
          }
        }
      }
      return false;
    }

    const filePath = this._resolveFilePath();
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读取配置文件
   * @param {boolean} useCache - 是否使用缓存
   * @returns {Promise<Object>}
   */
  async read(useCache = true) {
    // 检查缓存
    if (useCache && this._cache && (Date.now() - this._cacheTime < this._cacheTTL)) {
      return this._cache;
    }

    // 多文件配置处理
    if (this.multiFile) {
      return await this._readMultiFile();
    }

    try {
      // 解析目标文件路径（可能为动态路径）
      const filePath = this._resolveFilePath();

      // 检查文件是否存在；若不存在，尝试使用默认模板（config/default_config/<name>.yaml）
      let content;
      if (!await this.exists()) {
        let templatePath = null;
        for (const candidate of this._defaultTemplateCandidates()) {
          if (candidate && fsSync.existsSync(candidate)) {
            templatePath = candidate;
            break;
          }
        }
        if (templatePath) {
          content = await fs.readFile(templatePath, 'utf8');
          RuntimeUtil.makeLog(
            'debug',
            `使用默认配置模板 [${this.name}] ← ${path.relative(paths.root, templatePath)}`,
            'ConfigBase'
          );
        } else {
          throw new Error(`配置文件不存在: ${filePath}`);
        }
      } else {
        // 读取实际文件内容
        content = await fs.readFile(filePath, 'utf8');
      }

      // 解析内容
      let data;
      if (this.fileType === 'yaml') {
        data = yaml.parse(content);
      } else if (this.fileType === 'json') {
        data = JSON.parse(content);
      } else {
        throw new Error(`不支持的文件类型: ${this.fileType}`);
      }

      this._applySchemaDefaults(data);

      // 更新缓存
      this._cache = data;
      this._cacheTime = Date.now();

      return data;
    } catch (error) {
      RuntimeUtil.makeLog('error', `读取配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 读取多文件配置
   * @private
   * @returns {Promise<Object>}
   */
  async _readMultiFile() {
    const { keys, getFilePath, getDefaultFilePath } = this.multiFile;
    if (!keys || !Array.isArray(keys) || !getFilePath || typeof getFilePath !== 'function') {
      throw new Error(`多文件配置定义不完整: ${this.name}`);
    }

    const result = {};

    for (const key of keys) {
      const filePath = getFilePath(key);
      const defaultFilePath = getDefaultFilePath ? getDefaultFilePath(key) : null;
      
      let config = {};
      
      // 先读取默认配置（如果存在）
      if (defaultFilePath && fsSync.existsSync(defaultFilePath)) {
        try {
          const content = await fs.readFile(defaultFilePath, 'utf8');
          config = this.fileType === 'yaml' ? yaml.parse(content) : JSON.parse(content);
        } catch (error) {
          RuntimeUtil.makeLog('warn', `读取默认配置失败 [${this.name}/${key}]: ${error.message}`, 'ConfigBase');
        }
      }
      
      // 再读取实际配置（覆盖默认配置）
      if (fsSync.existsSync(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const fileConfig = this.fileType === 'yaml' ? yaml.parse(content) : JSON.parse(content);
          if (fileConfig) {
            config = { ...config, ...fileConfig };
          }
        } catch (error) {
          RuntimeUtil.makeLog('warn', `读取配置失败 [${this.name}/${key}]: ${error.message}`, 'ConfigBase');
        }
      }
      
      result[key] = config;
      const fieldSchema = this.schema?.fields?.[key];
      if (fieldSchema?.fields) {
        this._fillDefaultsInPlace(config, this.buildDefaultFromSchema({ fields: fieldSchema.fields }));
      }
    }

    // 顶层 multiFile 容器字段补全（如 renderer.puppeteer / playwright）
    this._applySchemaDefaults(result);

    // 更新缓存
    this._cache = result;
    this._cacheTime = Date.now();

    return result;
  }

  /**
   * 写入配置文件
   * @param {Object} data - 配置数据
   * @param {Object} options - 写入选项
   * @param {boolean} options.backup - 是否备份原文件
   * @param {boolean} options.validate - 是否验证数据
   * @param {boolean} options.cleanEmpty - 是否清理空值（默认 false，子类可覆盖）
   * @returns {Promise<boolean>}
   */
  async write(data, options = {}) {
    // 多文件配置处理
    if (this.multiFile) {
      return await this._writeMultiFile(data, options);
    }

    const { backup = true, validate = true, cleanEmpty = false } = options;

    try {
      // 清理空值（如果启用）
      let processedData = data;
      if (cleanEmpty) {
        processedData = this._cleanEmptyValues(data);
      }

      // 验证数据
      if (validate) {
        const validation = await this.validate(processedData);
        if (!validation.valid) {
          throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
        }
      }

      // 备份原文件
      if (backup && await this.exists()) {
        await this.backup();
      }

      // 确保目录存在（recursive: true 会自动处理已存在的情况）
      const filePath = this._resolveFilePath();
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // 序列化数据
      let content;
      if (this.fileType === 'yaml') {
        content = yaml.stringify(processedData, {
          indent: 2,
          lineWidth: 0,
          minContentWidth: 0
        });
      } else if (this.fileType === 'json') {
        content = JSON.stringify(processedData, null, 2);
      } else {
        throw new Error(`不支持的文件类型: ${this.fileType}`);
      }

      // 写入文件
      await fs.writeFile(filePath, content, 'utf8');

      // 清除缓存
      this._cache = processedData;
      this._cacheTime = Date.now();

      RuntimeUtil.makeLog('info', `配置已保存 [${this.name}]`, 'ConfigBase');
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `写入配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 写入多文件配置
   * @private
   * @param {Object} data - 配置数据，格式：{ key1: {...}, key2: {...} }
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async _writeMultiFile(data, options = {}) {
    const { backup = true, validate = true } = options;
    const { keys, getFilePath } = this.multiFile;

    try {
      // 验证数据
      if (validate) {
        const validation = await this.validate(data);
        if (!validation.valid) {
          throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
        }
      }

      // 分别写入每个文件
      for (const key of keys) {
        if (!data[key]) continue;

        const filePath = getFilePath(key);
        const dir = path.dirname(filePath);

        // 备份原文件（仅保留一份备份，先清理旧备份）
        if (backup && fsSync.existsSync(filePath)) {
          await this._pruneBackups(filePath);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const backupPath = `${filePath}.backup.${timestamp}`;
          await fs.copyFile(filePath, backupPath);
        }

        // 确保目录存在
        await fs.mkdir(dir, { recursive: true });

        // 序列化并写入
        let content;
        if (this.fileType === 'yaml') {
          content = yaml.stringify(data[key], {
            indent: 2,
            lineWidth: 0,
            minContentWidth: 0
          });
        } else if (this.fileType === 'json') {
          content = JSON.stringify(data[key], null, 2);
        } else {
          throw new Error(`不支持的文件类型: ${this.fileType}`);
        }

        await fs.writeFile(filePath, content, 'utf8');
      }

      // 更新缓存
      this._cache = data;
      this._cacheTime = Date.now();

      RuntimeUtil.makeLog('info', `多文件配置已保存 [${this.name}]`, 'ConfigBase');
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `写入多文件配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 删除该配置文件对应的旧备份，只保留一份备份（避免备份膨胀）
   * @private
   * @param {string} filePath - 配置文件路径（相对则基于项目根解析）
   */
  async _pruneBackups(filePath) {
    try {
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(paths.root, filePath);
      const dir = path.dirname(resolved);
      const base = path.basename(resolved);
      const prefix = `${base}.backup.`;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.startsWith(prefix)) {
          await fs.unlink(path.join(dir, e.name));
          RuntimeUtil.makeLog('debug', `已删除旧备份 [${this.name}]: ${e.name}`, 'ConfigBase');
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') RuntimeUtil.makeLog('debug', `清理旧备份时忽略 [${this.name}]: ${err.message}`, 'ConfigBase');
    }
  }

  /**
   * 备份配置文件（仅保留一份备份，新备份前会删除旧备份）
   * @returns {Promise<string>} 备份文件路径
   */
  async backup() {
    try {
      const filePath = this._resolveFilePath();
      await this._pruneBackups(filePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const backupPath = `${filePath}.backup.${timestamp}`;
      await fs.copyFile(filePath, backupPath);
      RuntimeUtil.makeLog('debug', `配置已备份 [${this.name}]: ${backupPath}`, 'ConfigBase');
      return backupPath;
    } catch (error) {
      RuntimeUtil.makeLog('error', `备份配置失败 [${this.name}]: ${error.message}`, 'ConfigBase');
      throw error;
    }
  }

  /**
   * 获取指定路径的配置值
   * 
   * 支持点号路径和数组索引，如 'server.host' 或 'server.proxy.domains[0].domain'
   * 
   * @param {string} keyPath - 键路径
   *   - 点号分隔：'server.host'
   *   - 数组索引：'domains[0]' 或 'server.proxy.domains[0].domain'
   * @returns {Promise<any>} 配置值，如果路径不存在返回undefined
   * @example
   * const host = await config.get('server.host');
   * const firstDomain = await config.get('server.proxy.domains[0].domain');
   */
  async get(keyPath) {
    const data = await this.read();
    return this._getValueByPath(data, keyPath);
  }

  /**
   * 设置指定路径的配置值
   * 
   * 如果路径不存在，会自动创建中间对象。
   * 
   * @param {string} keyPath - 键路径（支持点号和数组索引）
   * @param {any} value - 新值
   * @param {Object} options - 写入选项
   *   - backup: 是否备份（默认true）
   *   - validate: 是否验证（默认true）
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.set('server.host', '0.0.0.0');
   * await config.set('server.proxy.domains[0].domain', 'example.com');
   */
  async set(keyPath, value, options = {}) {
    const data = await this.read();
    this._setValueByPath(data, keyPath, value);
    return await this.write(data, options);
  }

  /**
   * 删除指定路径的配置
   * 
   * 删除指定路径的配置项，如果路径不存在则忽略。
   * 
   * @param {string} keyPath - 键路径（支持点号和数组索引）
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.delete('server.proxy.domains[0]');
   */
  async delete(keyPath, options = {}) {
    const data = await this.read();
    this._deleteValueByPath(data, keyPath);
    return await this.write(data, options);
  }

  /**
   * 追加到数组配置
   * 
   * 将值追加到指定路径的数组末尾。
   * 
   * @param {string} keyPath - 数组键路径（必须是数组类型）
   * @param {any} value - 要追加的值
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @throws {Error} 如果路径不是数组类型
   * @example
   * await config.append('server.auth.allowPaths', '/new-path');
   */
  async append(keyPath, value, options = {}) {
    const data = await this.read();
    const current = this._getValueByPath(data, keyPath);
    
    if (!Array.isArray(current)) {
      throw new Error(`路径 ${keyPath} 不是数组`);
    }
    
    current.push(value);
    return await this.write(data, options);
  }

  /**
   * 从数组配置中移除元素
   * 
   * 支持通过索引或查找函数移除数组元素。
   * 
   * @param {string} keyPath - 数组键路径（必须是数组类型）
   * @param {number|Function} indexOrPredicate - 移除方式
   *   - 数字：按索引移除，如 0 移除第一个元素
   *   - 函数：查找函数，如 (item) => item.id === 'target'
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>} 是否成功
   * @throws {Error} 如果路径不是数组类型
   * @example
   * // 按索引移除
   * await config.remove('server.auth.allowPaths', 0);
   * 
   * // 按条件移除
   * await config.remove('domains', (item) => item.domain === 'old.com');
   */
  async remove(keyPath, indexOrPredicate, options = {}) {
    const data = await this.read();
    const current = this._getValueByPath(data, keyPath);
    
    if (!Array.isArray(current)) {
      throw new Error(`路径 ${keyPath} 不是数组`);
    }
    
    if (typeof indexOrPredicate === 'number') {
      current.splice(indexOrPredicate, 1);
    } else if (typeof indexOrPredicate === 'function') {
      const index = current.findIndex(indexOrPredicate);
      if (index !== -1) {
        current.splice(index, 1);
      }
    }
    
    return await this.write(data, options);
  }

  /**
   * 合并配置
   * 
   * 将新配置数据合并到现有配置中，支持浅合并和深合并。
   * 
   * @param {Object} newData - 新配置数据
   * @param {Object} options - 合并选项
   *   - deep: 是否深度合并（默认true）
   *   - backup: 是否备份（默认true）
   *   - validate: 是否验证（默认true）
   * @returns {Promise<boolean>} 是否成功
   * @example
   * await config.merge({
   *   server: {
   *     host: '0.0.0.0',
   *     port: 8086
   *   }
   * });
   */
  async merge(newData, options = {}) {
    const { deep = true } = options;
    const currentData = await this.read();
    
    const mergedData = deep 
      ? this._deepMerge(currentData, newData)
      : { ...currentData, ...newData };
    
    return await this.write(mergedData, options);
  }

  /**
   * 验证配置数据
   * 
   * 根据schema定义验证配置数据的类型、范围、长度等。
   * 
   * @param {Object} data - 要验证的数据
   * @returns {Promise<Object>} 验证结果
   *   - valid: 是否有效
   *   - errors: 错误信息数组
   * @example
   * const result = await config.validate({ host: '0.0.0.0', port: 8086 });
   * if (!result.valid) {
   *   console.error('验证失败:', result.errors);
   * }
   */
  async validate(data) {
    const errors = [];

    try {
      if (typeof this.prepareValidate === 'function') {
        this.prepareValidate(data);
      }
      this._applySchemaDefaults(data);

      // 基础验证：检查必需字段
      if (this.schema.required) {
        for (const field of this.schema.required) {
          if (!(field in data)) {
            errors.push(`缺少必需字段: ${field}`);
          }
        }
      }

      if (this.schema.fields) {
        for (const [field, fieldSchema] of Object.entries(this.schema.fields)) {
          if (!(field in data)) continue;

          const fieldPath = field;
          let value = data[field];
          value = this._normalizeValueBySchema(value, fieldSchema);
          data[field] = value;

          if (value === undefined) {
            if (fieldSchema.nullable === true) continue;
            errors.push(`字段 ${fieldPath} 不允许为空`);
            continue;
          }

          if (fieldSchema.type && !this._checkType(value, fieldSchema.type)) {
            errors.push(`字段 ${fieldPath} 类型错误，期望 ${fieldSchema.type}`);
            continue;
          }

          this._runFieldValidators(value, fieldSchema, fieldPath, errors);

          if (fieldSchema.type === 'array') {
            this._validateArrayField(value, fieldSchema, fieldPath, errors);
          }

          if (fieldSchema.type === 'map' && fieldSchema.fields) {
            this._validateKeyedMapField(value, fieldSchema, fieldPath, errors);
          } else if ((fieldSchema.type === 'object' || fieldSchema.type === 'map') && fieldSchema.fields) {
            this._validateObjectField(value, fieldSchema, fieldPath, errors);
          }
        }
      }

      this._validateKeyedSiblingCollections(data, errors);

      if (typeof this.customValidate === 'function') {
        const customErrors = await this.customValidate(data);
        if (Array.isArray(customErrors)) {
          errors.push(...customErrors);
        }
      }

    } catch (error) {
      errors.push(`验证过程出错: ${error.message}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 获取配置描述信息（标准化注册方法）
   * @returns {Object} 配置描述信息
   */
  getInfo() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      filePath: this.filePath,
      fileType: this.fileType
    };
  }

  /**
   * 获取配置结构（用于前端渲染表单）
   * @returns {Object} 配置结构信息（包含schema）
   */
  getStructure() {
    return {
      ...this.getInfo(),
      schema: this.schema
    };
  }

  /**
   * 重置为默认配置
   * @param {Object} options - 写入选项
   * @returns {Promise<boolean>}
   */
  async reset(options = {}) {
    if (!this.defaultConfig) {
      throw new Error('未定义默认配置');
    }
    return await this.write(this.defaultConfig, options);
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this._cache = null;
    this._cacheTime = 0;
  }

  // ========== 生成默认对象与扁平化工具 ==========

  /**
   * 将 schema 默认值填入 data（仅补缺失字段，不覆盖已有值）
   * @param {object} data
   */
  _applySchemaDefaults(data) {
    if (!data || typeof data !== 'object') return;
    this._fillDefaultsInPlace(data, this.buildDefaultFromSchema());
  }

  buildDefaultFromSchema(schema = this.schema) {
    const result = {};
    if (!schema?.fields) return result;
    for (const [key, fs] of Object.entries(schema.fields)) {
      if (fs.type === 'map') {
        result[key] = Object.hasOwn(fs, 'default')
          ? this._cloneDefaultValue(fs.default)
          : {};
      } else if (fs.type === 'object') {
        result[key] = this.buildDefaultFromSchema({ fields: fs.fields ?? {} });
      } else if (fs.type === 'array') {
        result[key] = Array.isArray(fs.default) ? [...fs.default] : [];
      } else if (Object.hasOwn(fs, 'default')) {
        result[key] = fs.default;
      }
    }
    return result;
  }

  /**
   * 将 schema 默认值填入 data 中缺失的字段（不覆盖用户已配置的值）
   * @param {object} target
   * @param {object} defaults
   */
  _fillDefaultsInPlace(target, defaults) {
    if (!target || typeof target !== 'object' || !defaults || typeof defaults !== 'object') return;

    for (const [key, defVal] of Object.entries(defaults)) {
      const cur = target[key];
      const missing = !Object.hasOwn(target, key) || cur === null || cur === undefined;

      if (missing) {
        if (defVal === undefined) continue;
        target[key] = this._cloneDefaultValue(defVal);
        continue;
      }

      if (
        this._isObject(defVal) && !Array.isArray(defVal) &&
        this._isObject(cur) && !Array.isArray(cur)
      ) {
        this._fillDefaultsInPlace(cur, defVal);
      }
    }
  }

  _cloneDefaultValue(value) {
    if (Array.isArray(value)) return [...value];
    if (this._isObject(value)) {
      return structuredClone(value);
    }
    return value;
  }

  getFlatSchema(prefix = '', schema = this.schema) {
    const list = [];
    if (!schema?.fields) return list;
    for (const [key, fs] of Object.entries(schema.fields)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (fs.type === 'map') {
        // map：fields 是「每个动态键」的值模板，不能当子路径展开，否则前端只能看到空 JSON
        const valueFields = fs.fields || fs.itemSchema?.fields || null;
        const hasValueFields = Boolean(valueFields && Object.keys(valueFields).length > 0);
        list.push({
          path,
          type: 'map',
          component: fs.component || 'keyedObject',
          container: false,
          meta: {
            ...fs,
            container: false,
            fields: valueFields,
            itemFields: valueFields,
            keyLabel: fs.keyLabel || fs.meta?.keyLabel,
            keyPlaceholder: fs.keyPlaceholder || fs.meta?.keyPlaceholder,
          },
        });
        if (hasValueFields) {
          list.push(...this.getFlatSchema(`${path}[]`, { fields: valueFields }));
        }
      } else if (fs.type === 'object') {
        const childFields = fs.fields && typeof fs.fields === 'object' ? fs.fields : null;
        const hasChildren = Boolean(childFields && Object.keys(childFields).length > 0);
        // container=true：仅作分组壳（有子字段已展开），前端勿再渲染空 JSON 编辑器
        // 无子字段的 object/SubForm：前端渲染自由对象 / keyed 编辑器
        list.push({
          path,
          type: fs.type,
          component: fs.component,
          container: hasChildren,
          meta: { ...fs, container: hasChildren },
        });
        if (hasChildren) {
          list.push(...this.getFlatSchema(path, { fields: childFields }));
        }
      } else if (fs.type === 'array' && fs.itemType === 'object') {
        // 数组<Object> 类型：始终为数组本身生成一条描述，
        // 同时递归展开元素结构（无论使用 itemSchema 还是直接使用 fields 定义）
        const itemFields = fs.itemSchema?.fields ?? fs.fields ?? {};

        // 用单条记录描述整个数组字段（用于渲染 ArrayForm、保存时整体替换）
        list.push({
          path,
          type: 'array<object>',
          component: fs.component,
          container: false,
          meta: { ...fs, container: false },
        });

        // 再为数组元素生成模板路径（xxx[]....），用于：
        // - getFlatFieldDefinition / normalizeFieldValue 推断子字段类型
        // - ArrayForm 子项的默认值生成与校验
        if (Object.keys(itemFields).length > 0) {
          list.push(...this.getFlatSchema(`${path}[]`, { fields: itemFields }));
        }
      } else {
        list.push({
          path,
          type: fs.type,
          component: fs.component,
          container: false,
          meta: { ...fs, container: false },
        });
      }
    }

    // meta.collections：根级动态键（如 group 的群号覆盖，与 default 并列）
    if (!prefix && Array.isArray(schema?.meta?.collections)) {
      for (const col of schema.meta.collections) {
        const colType = String(col?.type || col?.component || '').toLowerCase();
        if (colType !== 'keyedobject' && colType !== 'map') continue;
        const name = col.name;
        if (!name) continue;
        const templateFields = this._resolveCollectionValueFields(col, schema);
        const excludeKeys = Array.isArray(col.excludeKeys)
          ? col.excludeKeys
          : Object.keys(schema.fields || {});
        const keyedSiblings = col.basePath === '' || col.basePath == null;
        list.push({
          path: name,
          type: 'map',
          component: col.component || 'keyedObject',
          container: false,
          meta: {
            ...col,
            type: 'map',
            container: false,
            keyedSiblings,
            excludeKeys,
            fields: templateFields,
            itemFields: templateFields,
            keyLabel: col.keyLabel,
            keyPlaceholder: col.keyPlaceholder,
            label: col.label || name,
            description: col.description || '',
            group: col.group || col.label || name,
          },
        });
        if (templateFields && Object.keys(templateFields).length) {
          list.push(...this.getFlatSchema(`${name}[]`, { fields: templateFields }));
        }
      }
    }
    return list;
  }

  /**
   * collections 值模板：valueTemplatePath 指向 fields 下某 object 的 fields
   * @private
   */
  _resolveCollectionValueFields(col, schema) {
    if (col?.fields && typeof col.fields === 'object') return col.fields;
    if (col?.itemSchema?.fields) return col.itemSchema.fields;
    const tpl = col?.valueTemplatePath;
    if (!tpl || !schema?.fields) return null;
    const node = schema.fields[tpl];
    return node?.fields && typeof node.fields === 'object' ? node.fields : null;
  }

  flattenData(obj, prefix = '') {
    const out = {};
    if (typeof obj !== 'object' || obj === null) return out;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 空对象需要保留自身路径，否则前端 flat 视图无法编辑（例如 headers: {}）
        const keys = Object.keys(v);
        if (keys.length === 0) {
          out[path] = {};
        } else {
          Object.assign(out, this.flattenData(v, path));
        }
      } else {
        out[path] = v;
      }
    }
    return out;
  }

  expandFlatData(flat) {
    const data = {};
    for (const [path, value] of Object.entries(flat ?? {})) {
      this._setValueByPath(data, path, value);
    }
    return data;
  }

  // ==================== 私有辅助方法 ====================

  _runFieldValidators(value, schema, path, errors) {
    const expectedType = schema.type;
    if (expectedType === 'number') {
      if (schema.min !== undefined && value < schema.min) {
        errors.push(`字段 ${path} 不能小于 ${schema.min}`);
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(`字段 ${path} 不能大于 ${schema.max}`);
      }
    }

    if (expectedType === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`字段 ${path} 长度不能小于 ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`字段 ${path} 长度不能大于 ${schema.maxLength}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`字段 ${path} 格式不正确`);
      }
    }

    // enum：非必填字段允许留空；动态 enum 会把已持久化值并入可选列表（见 SystemConfig）
    if (schema.enum && !this._enumValueAllowed(value, schema)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (this._enumValueAllowed(item, schema)) continue;
          errors.push(`字段 ${path} 中的值 "${item}" 必须是: ${schema.enum.join(', ')}`);
        }
      } else {
        errors.push(`字段 ${path} 值必须是: ${schema.enum.join(', ')}`);
      }
    }
  }

  /** @returns {boolean} */
  _enumValueAllowed(value, schema) {
    if (!schema?.enum) return true;
    if (value === '' && schema.required !== true) return true;
    return schema.enum.includes(value);
  }

  _validateArrayField(value, schema, path, errors) {
    if (!Array.isArray(value)) {
      errors.push(`字段 ${path} 必须为数组`);
      return;
    }

    if (!schema.itemType) return;

    const itemSchema = schema.itemSchema || { fields: schema.fields ?? {} };

    value.forEach((item, idx) => {
      const itemPath = `${path}[${idx}]`;
      const expectedType = schema.itemType;
      const itemSchemaWithType = { ...itemSchema, type: expectedType };
      const normalizedItem = this._normalizeValueBySchema(item, itemSchemaWithType);
      value[idx] = normalizedItem;

      if (!this._checkType(normalizedItem, expectedType)) {
        errors.push(`字段 ${itemPath} 类型错误，应为 ${expectedType}`);
        return;
      }

      this._runFieldValidators(normalizedItem, itemSchemaWithType, itemPath, errors);

      if ((expectedType === 'object' || expectedType === 'map') && (itemSchema.fields || schema.fields)) {
        this._validateObjectField(normalizedItem, { ...itemSchemaWithType, fields: itemSchema.fields ?? schema.fields }, itemPath, errors);
      }
    });
  }

  _validateKeyedMapField(value, schema, path, errors) {
    if (!this._isObject(value)) {
      errors.push(`字段 ${path} 必须为对象（map）`);
      return;
    }
    const valueSchema = {
      type: 'object',
      fields: schema.fields ?? schema.itemSchema?.fields ?? {},
    };
    for (const [entryKey, entryVal] of Object.entries(value)) {
      const entryPath = `${path}.${entryKey}`;
      if (!this._isObject(entryVal)) {
        errors.push(`字段 ${entryPath} 必须为对象`);
        continue;
      }
      this._validateObjectField(entryVal, valueSchema, entryPath, errors);
    }
  }

  /**
   * meta.collections 根级动态键（如 chatbot 群号覆盖）：按值模板校验
   * @private
   */
  _validateKeyedSiblingCollections(data, errors) {
    if (!this._isObject(data)) return;
    const collections = this.schema?.meta?.collections;
    if (!Array.isArray(collections) || !collections.length) return;

    for (const col of collections) {
      const colType = String(col?.type || col?.component || '').toLowerCase();
      if (colType !== 'keyedobject' && colType !== 'map') continue;
      if (col.basePath !== '' && col.basePath != null) continue;

      const exclude = new Set(
        Array.isArray(col.excludeKeys) && col.excludeKeys.length
          ? col.excludeKeys
          : Object.keys(this.schema?.fields || {}),
      );
      if (col.name) exclude.add(col.name);

      const valueFields = this._resolveCollectionValueFields(col, this.schema);
      if (!valueFields || !Object.keys(valueFields).length) continue;

      const valueSchema = { type: 'object', fields: valueFields };
      for (const [key, val] of Object.entries(data)) {
        if (exclude.has(key)) continue;
        if (!this._isObject(val)) {
          errors.push(`字段 ${key} 必须为对象（${col.label || col.name || '动态覆盖'}）`);
          continue;
        }
        this._validateObjectField(val, valueSchema, key, errors);
      }
    }
  }

  _validateObjectField(value, schema, path, errors) {
    if (!this._isObject(value)) {
      errors.push(`字段 ${path} 必须为对象`);
      return;
    }

    const fields = schema.fields ?? {};
    const requiredFields = Array.isArray(schema.required) ? schema.required : [];
    for (const [key, childSchema] of Object.entries(fields)) {
      const childPath = `${path}.${key}`;
      let childValue = value[key];

      const isRequired = requiredFields.includes(key) || childSchema?.required === true;
      if (childValue === undefined) {
        // 对于未标记为必填的字段，允许缺失（按“存在就是存在，不存在就略过”的规则）
        if (!isRequired || childSchema?.nullable === true) continue;
        errors.push(`字段 ${childPath} 不允许为空`);
        continue;
      }

      childValue = this._normalizeValueBySchema(childValue, childSchema);
      value[key] = childValue;
      if (childValue === undefined) {
        if (!isRequired || childSchema?.nullable === true) continue;
        errors.push(`字段 ${childPath} 不允许为空`);
        continue;
      }

      if (childSchema.type && !this._checkType(childValue, childSchema.type)) {
        errors.push(`字段 ${childPath} 类型错误，期望 ${childSchema.type}`);
        continue;
      }

      this._runFieldValidators(childValue, childSchema, childPath, errors);

      if (childSchema.type === 'array') {
        this._validateArrayField(childValue, childSchema, childPath, errors);
      }

      if ((childSchema.type === 'object' || childSchema.type === 'map') && childSchema.fields) {
        this._validateObjectField(childValue, childSchema, childPath, errors);
      }
    }
  }

  _normalizeValueBySchema(value, schema = {}) {
    if (value === undefined) return;
    const expectedType = schema.type;

    // ========= 基础标量类型自动转换 =========
    if (expectedType === 'string') {
      return typeof value === 'string' ? value : String(value);
    }

    if (expectedType === 'number') {
      if (typeof value === 'number' && !isNaN(value)) return value;
      if (value === null || value === '') return undefined; // 留空视为未设置，由下游默认
      if (typeof value === 'string') {
        const num = Number(value);
        return isNaN(num) ? value : num;
      }
      return value;
    }

    if (expectedType === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      }
      if (typeof value === 'number') return value !== 0;
      return !!value;
    }

    if (expectedType === 'array') {
      let arr = Array.isArray(value) ? [...value] : (value == null ? [] : [value]);
      if (schema.itemType) {
        const itemSchema = schema.itemSchema || { fields: schema.fields ?? {} };
        arr = arr.map(item => this._normalizeValueBySchema(item, { ...itemSchema, type: schema.itemType }));
      }
      return arr;
    }

    // ========= 对象 / Map 类型自动转换 =========
    if (expectedType === 'object' || expectedType === 'map') {
      let obj = value;

      // 兼容 Textarea 等组件：如果传入的是字符串，尝试按 JSON 解析
      // 典型场景：如 ai-workflow.mcp.remote.servers[*].headers 字段，前端用 Textarea 输入 JSON
      if (typeof obj === 'string') {
        const trimmed = obj.trim();
        // 空字符串视为“未填写”，交给上层必填规则处理（通常为可选字段）
        if (!trimmed) {
          return undefined;
        }
        // 形如 JSON 对象的字符串尝试解析
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (this._isObject(parsed)) {
              obj = parsed;
            }
          } catch {
            // 如果解析失败，保持原值交给后续类型检查报错，避免静默吞掉错误
          }
        }
      }

      if (this._isObject(obj)) {
        const clone = { ...obj };
        const fields = schema.fields ?? {};
        for (const [key, childSchema] of Object.entries(fields)) {
          if (clone[key] !== undefined) {
            clone[key] = this._normalizeValueBySchema(clone[key], childSchema);
          }
        }
        return clone;
      }
    }

    return value;
  }

  /**
   * 解析数组索引键
   * @private
   */
  _parseArrayKey(key) {
    const match = key.match(/^(.+?)\[(\d+)\]$/);
    return match ? { arrayKey: match[1], index: parseInt(match[2]) } : null;
  }

  /**
   * 通过路径获取值
   * @private
   */
  _getValueByPath(obj, keyPath) {
    if (!keyPath) return obj;
    
    const keys = keyPath.split('.');
    let current = obj;

    for (const key of keys) {
      const parsed = this._parseArrayKey(key);
      current = parsed 
        ? current?.[parsed.arrayKey]?.[parsed.index]
        : current?.[key];
      if (current === undefined) return;
    }

    return current;
  }

  /**
   * 通过路径设置值
   * @private
   */
  _setValueByPath(obj, keyPath, value) {
    const keys = keyPath.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const parsed = this._parseArrayKey(keys[i]);
      if (parsed) {
        current[parsed.arrayKey] ||= [];
        current[parsed.arrayKey][parsed.index] ||= {};
        current = current[parsed.arrayKey][parsed.index];
      } else {
        current[keys[i]] ||= {};
        current = current[keys[i]];
      }
    }

    const lastParsed = this._parseArrayKey(keys[keys.length - 1]);
    if (lastParsed) {
      current[lastParsed.arrayKey] ||= [];
      current[lastParsed.arrayKey][lastParsed.index] = value;
    } else {
      current[keys[keys.length - 1]] = value;
    }
  }

  /**
   * 通过路径删除值
   * @private
   */
  _deleteValueByPath(obj, keyPath) {
    const keys = keyPath.split('.');
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const parsed = this._parseArrayKey(keys[i]);
      current = parsed 
        ? current[parsed.arrayKey]?.[parsed.index]
        : current[keys[i]];
      if (!current) return;
    }

    const lastParsed = this._parseArrayKey(keys[keys.length - 1]);
    if (lastParsed) {
      current[lastParsed.arrayKey]?.splice(lastParsed.index, 1);
    } else {
      delete current[keys[keys.length - 1]];
    }
  }

  /**
   * 深度合并对象
   * @private
   */
  _deepMerge(target, source) {
    const output = { ...target };

    if (this._isObject(target) && this._isObject(source)) {
      Object.keys(source).forEach(key => {
        output[key] = this._isObject(source[key]) && (key in target)
          ? this._deepMerge(target[key], source[key])
          : source[key];
      });
    }

    return output;
  }

  /**
   * 清理空值（用于写入前过滤）
   * 子类可以覆盖此方法以自定义清理逻辑
   * @private
   * @param {Object} obj - 要清理的对象
   * @returns {Object} 清理后的对象
   */
  _cleanEmptyValues(obj) {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      // 过滤数组中的空值
      return obj.filter(item => {
        if (item === undefined || item === null) return false;
        if (typeof item === 'string' && item.trim() === '') return false;
        return true;
      }).map(item => this._cleanEmptyValues(item));
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // 跳过 undefined
      if (value === undefined) continue;

      // 跳过空字符串（根据 schema 判断是否可选）
      if (typeof value === 'string' && value.trim() === '') {
        const fieldSchema = this.schema?.fields?.[key];
        if (!fieldSchema?.required && !this._isRequiredField(key)) {
          continue;
        }
      }

      // 跳过空数组（根据 schema 判断是否可选）
      if (Array.isArray(value) && value.length === 0) {
        const fieldSchema = this.schema?.fields?.[key];
        if (!fieldSchema?.required && !this._isRequiredField(key)) {
          continue;
        }
      }

      // 跳过空对象（根据 schema 判断是否可选）
      if (this._isObject(value) && Object.keys(value).length === 0) {
        const fieldSchema = this.schema?.fields?.[key];
        if (!fieldSchema?.required && !this._isRequiredField(key)) {
          continue;
        }
      }

      // 递归清理对象和数组
      if (typeof value === 'object' && value !== null) {
        const cleaned = this._cleanEmptyValues(value);
        // 清理后如果变成空对象/数组且是可选字段，则跳过
        const fieldSchema = this.schema?.fields?.[key];
        if (!fieldSchema?.required && !this._isRequiredField(key)) {
          if (Array.isArray(cleaned) && cleaned.length === 0) continue;
          if (this._isObject(cleaned) && Object.keys(cleaned).length === 0) continue;
        }
        result[key] = cleaned;
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 判断字段是否为必填字段
   * @private
   * @param {string} key - 字段名
   * @returns {boolean}
   */
  _isRequiredField(key) {
    // 检查 schema.required 数组
    if (this.schema?.required && Array.isArray(this.schema.required)) {
      return this.schema.required.includes(key);
    }
    return false;
  }

  /**
   * 检查是否为对象
   * @private
   */
  _isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * 类型检查
   * @private
   */
  _checkType(value, expectedType) {
    switch (expectedType) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && !isNaN(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
      case 'map':
        return this._isObject(value);
      default:
        return true;
    }
  }
}