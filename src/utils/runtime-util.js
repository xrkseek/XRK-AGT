import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from 'node:crypto';
import { glob as globLib } from 'glob';
import { ulid } from "ulid";
import { fileTypeFromBuffer } from "file-type";
import md5 from "md5";
import moment from "moment";
import chalk from "chalk";

import runtimeConfig from "#infrastructure/config/config.js";
import common from './common.js';
import paths from '#utils/paths.js';
import { exec, execFile } from './exec-async.js';
import { normalizeError } from './normalize-error.js';
import { inlineBinaryFromRef, isPathLike } from './media-ref.js';

/**
 * AgentRuntime 实用工具类
 * 
 * 提供各种实用函数，包括文件操作、字符串处理、网络请求、缓存管理等。
 * 所有方法都是静态方法，可以直接通过类名调用。
 * 
 * @class RuntimeUtil
 * @static
 * @example
 * // 使用工具函数
 * import RuntimeUtil from '#utils/runtime-util.js';
 * 
 * // 文件操作
 * await RuntimeUtil.mkdir('./data');
 * const content = await RuntimeUtil.readFile('./config.yaml');
 * 
 * // 字符串处理
 * const uuid = RuntimeUtil.uuid();
 * const randomStr = RuntimeUtil.randomString(32);
 * 
 * // 外联请求用全局 fetch / #utils/fetch-with-retry.js（无 RuntimeUtil.fetch）
 * 
 * // 缓存管理
 * const cache = RuntimeUtil.getMap('my-cache', { ttl: 60000 });
 * cache.set('key', 'value');
 */
export default class RuntimeUtil {
  /**
   * @static
   * @private
   * @type {string}
   */
  static apiKey = '';

  /**
   * 正则表达式缓存，用于性能优化
   * @static
   * @private
   * @type {Object<string, RegExp>}
   */
  static regexCache = {
    url: /^https?:\/\//,
    base64: /^base64:\/\//,
    controlChars: /\u001b\[\d+(;\d+)*m/g,
    globPattern: /[*?[\]{}]/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    ipv6: /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4})$/,
    chinese: /[\u4e00-\u9fa5]/g
  };

  /**
   * MIME 类型到文件扩展名的映射
   * @static
   * @private
   * @type {Map<string, string>}
   */
  static mimeToExtMap = new Map([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/gif', '.gif'],
    ['image/webp', '.webp'],
    ['image/svg+xml', '.svg'],
    ['audio/mpeg', '.mp3'],
    ['audio/wav', '.wav'],
    ['video/mp4', '.mp4'],
    ['video/webm', '.webm'],
    ['application/pdf', '.pdf'],
    ['application/json', '.json'],
    ['application/zip', '.zip'],
    ['text/plain', '.txt'],
    ['text/html', '.html'],
    ['text/css', '.css'],
    ['text/javascript', '.js']
  ]);

  /**
   * 全局 Map 存储
   * @static
   * @private
   * @type {Map<string, Map>}
   */
  static #globalMaps = new Map();

  /**
   * 内存缓存存储
   * @static
   * @private
   * @type {Map<string, Object>}
   */
  static #memoryCache = new Map();


  /**
   * 日志 ID 颜色方案
   * @static
   * @type {Object<string, Array<string>>}
   */
  static idColorSchemes = {
    default: ['#00D9FF', '#00C9E6', '#00B8CC', '#00A6B3', '#009599'],
    scheme1: ['#FF00FF', '#E91E63', '#C2185B', '#AD1457', '#880E4F'],
    scheme2: ['#FF9800', '#FB8C00', '#F57C00', '#EF6C00', '#E65100'],
    scheme3: ['#FFD700', '#FFC107', '#FFB300', '#FFA000', '#FF8F00'],
    scheme4: ['#00BCD4', '#00ACC1', '#0097A7', '#00838F', '#006064'],
    scheme5: ['#FF6B6B', '#FE7A7A', '#FD8989', '#FC9898', '#FBA7A7'],
    scheme6: ['#74EBD5', '#6DDDC4', '#66CEB3', '#5FBFA2', '#58B091'],
    scheme7: ['#D4A574', '#CD9A67', '#C68F5A', '#BF844D', '#B87940']
  };

  // 初始化定期缓存清理
  static {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of RuntimeUtil.#memoryCache) {
        if (cached.ttl > 0 && now > cached.expireAt) {
          RuntimeUtil.#memoryCache.delete(key);
        }
      }
    }, 60000);
    // 不阻塞进程退出（避免热重启/停止卡住）
    timer.unref?.();
  }

  // ========== Map 管理 ==========

  /**
   * 获取或创建具有扩展功能的 Map 对象
   * @param {string} [name='default'] - Map 标识符
   * @param {Object} [options={}] - 配置选项
   * @param {number} [options.maxSize=Infinity] - 最大大小限制
   * @param {number} [options.ttl=0] - 生存时间（毫秒）
   * @param {Function} [options.onEvict=null] - 项目被驱逐时的回调
   * @param {boolean} [options.autoClean=false] - 启用自动清理
   * @param {number} [options.cleanInterval=60000] - 清理间隔（毫秒）
   * @returns {Map} 具有额外方法的扩展 Map 对象
   */
  static getMap(name = 'default', options = {}) {
    return RuntimeUtil.#globalMaps.getOrInsertComputed(name, () => RuntimeUtil.#createExtendedMap(options));
  }

  /**
   * 创建具有额外功能的扩展 Map
   * @private
   * @param {Object} options - 配置选项
   * @returns {Map} 扩展 Map 对象
   */
  static #createExtendedMap(options) {
    const {
      maxSize = Infinity,
      ttl = 0,
      onEvict = null,
      autoClean = false,
      cleanInterval = 60000
    } = options;

    const map = new Map();
    map._metadata = new Map();
    map._options = { maxSize, ttl, onEvict, autoClean, cleanInterval };

    const originalSet = map.set.bind(map);
    map.set = function (key, value) {
      if (this.size >= maxSize && !this.has(key)) {
        const firstKey = this.keys().next().value;
        if (onEvict) onEvict(firstKey, this.get(firstKey));
        this.delete(firstKey);
        this._metadata.delete(firstKey);
      }

      originalSet(key, value);

      if (ttl > 0) {
        this._metadata.set(key, {
          createdAt: Date.now(),
          ttl: ttl
        });
      }

      return this;
    };

    const originalGet = map.get.bind(map);
    map.get = function (key) {
      if (ttl > 0 && this._metadata.has(key)) {
        const metadata = this._metadata.get(key);
        if (Date.now() - metadata.createdAt > metadata.ttl) {
          if (onEvict) onEvict(key, originalGet(key));
          this.delete(key);
          this._metadata.delete(key);
          return undefined;
        }
      }
      return originalGet(key);
    };

    map.setMany = function (entries) {
      for (const [key, value] of entries) {
        this.set(key, value);
      }
      return this;
    };

    map.getMany = function (keys) {
      const result = new Map();
      for (const key of keys) {
        const value = this.get(key);
        if (value !== undefined) result.set(key, value);
      }
      return result;
    };

    map.cleanExpired = function () {
      if (ttl <= 0) return 0;
      let cleaned = 0;
      const now = Date.now();
      for (const [key, metadata] of this._metadata.entries()) {
        if (now - metadata.createdAt > metadata.ttl) {
          if (onEvict) onEvict(key, originalGet(key));
          this.delete(key);
          this._metadata.delete(key);
          cleaned++;
        }
      }
      return cleaned;
    };

    map.destroy = function () {
      if (this._cleanInterval) {
        clearInterval(this._cleanInterval);
      }
      this.clear();
      this._metadata.clear();
    };

    if (autoClean && ttl > 0) {
      map._cleanInterval = setInterval(() => {
        map.cleanExpired();
      }, cleanInterval);
      map._cleanInterval.unref?.();
    }

    return map;
  }

  /**
   * 删除命名的 Map
   * @param {string} name - Map 标识符
   * @returns {boolean} 删除是否成功
   */
  static deleteMap(name) {
    const map = RuntimeUtil.#globalMaps.get(name);
    if (map) {
      if (typeof map.destroy === 'function') map.destroy();
      return RuntimeUtil.#globalMaps.delete(name);
    }
    return false;
  }

  // ========== 缓存管理 ==========

  /**
   * 内存缓存操作 - 获取或设置缓存值
   * @param {string} key - 缓存键
   * @param {*} [value] - 要缓存的值（省略则获取）
   * @param {number} [ttl=0] - 生存时间（毫秒）（0 = 不过期）
   * @returns {*} 缓存的值或 undefined
   */
  static cache(key, value, ttl = 0) {
    if (value === undefined) {
      const cached = RuntimeUtil.#memoryCache.get(key);
      if (cached) {
        if (cached.ttl === 0 || Date.now() < cached.expireAt) {
          return cached.value;
        }
        RuntimeUtil.#memoryCache.delete(key);
      }
      return undefined;
    }

    RuntimeUtil.#memoryCache.set(key, {
      value,
      ttl,
      expireAt: ttl > 0 ? Date.now() + ttl : 0,
      createdAt: Date.now()
    });

    return value;
  }

  /**
   * 清除缓存条目
   * @param {string|RegExp} [pattern] - 要匹配的键或正则表达式模式
   * @returns {number} 删除的条目数
   */
  static clearCache(pattern) {
    if (!pattern) {
      const size = RuntimeUtil.#memoryCache.size;
      RuntimeUtil.#memoryCache.clear();
      return size;
    }

    let deleted = 0;
    const isRegex = pattern instanceof RegExp;

    for (const [key] of RuntimeUtil.#memoryCache) {
      if (isRegex ? pattern.test(key) : key === pattern) {
        RuntimeUtil.#memoryCache.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  // ========== 字符串和数据处理 ==========

  /**
   * 生成唯一标识符
   * @param {string} [version='v4'] - UUID 版本（'v4' 或 'ulid'）
   * @returns {string} 生成的唯一标识符
   */
  static uuid(version = 'v4') {
    if (version === 'ulid') return ulid();

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** 短随机 id（事件去重、requestId 等） */
  static shortId() {
    return crypto.randomBytes(6).toHex();
  }

  /**
   * 生成随机字符串
   * @param {number} [length=10] - 字符串长度
   * @param {string} [chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'] - 字符集
   * @returns {string} 随机字符串
   */
  static randomString(length = 10, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let result = '';
    const charsLength = chars.length;
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * charsLength));
    }
    return result;
  }

  /**
   * 计算数据的哈希值
   * @param {string|Buffer} data - 要哈希的数据
   * @param {string} [algorithm='md5'] - 哈希算法
   * @returns {string} 十六进制哈希字符串
   */
  static hash(data, algorithm = 'md5') {
    if (algorithm === 'md5') return md5(data);
    return crypto.createHash(algorithm).update(data).digest('hex');
  }

  /**
   * 将任何数据转换为字符串表示
   * @param {*} data - 要转换的数据
   * @returns {string} 字符串表示
   */
  static String(data) {
    if (data == null) return String(data);

    switch (typeof data) {
      case "string":
        return data;
      case "function":
        return `[Function: ${data.name || "anonymous"}]`;
      case "object":
        if (Error.isError(data)) {
          return data.stack || data.message || String(data);
        }
        if (Buffer.isBuffer(data)) {
          if (data.length > 1024) {
            return `[Binary data, length: ${data.length}]`;
          }
          return `base64://${data.toBase64()}`;
        }
        try {
          return JSON.stringify(data);
        } catch {
          return "[Object]";
        }
      default:
        return String(data);
    }
  }

  /**
   * 将数据转换为字符串或缓冲区
   * @param {*} data - 要转换的数据
   * @param {boolean} [base64=false] - 对二进制使用 base64 编码
   * @returns {string|Buffer} 转换结果
   */
  static StringOrBuffer(data, base64) {
    if (!Buffer.isBuffer(data)) return String(data);

    const string = data.toString();
    if (string.includes("\ufffd") || /[\uD800-\uDFFF]/.test(string)) {
      return base64 ? `base64://${data.toBase64()}` : data;
    }
    return string;
  }

  // ========== 日志系统（仅格式化，不写入） ==========

  /**
   * 计算字符串的显示宽度（考虑双宽字符）
   * @private
   * @param {string} str - 要测量的字符串
   * @returns {number} 显示宽度
   */
  static #getDisplayWidth(str) {
    if (typeof str !== 'string') str = String(str);
    let width = 0;
    for (const char of str) {
      const code = char.charCodeAt(0);
      // CJK 统一表意文字
      if ((code >= 0x4E00 && code <= 0x9FFF) ||
        // CJK 符号和标点
        (code >= 0x3000 && code <= 0x303F) ||
        // 平假名和片假名
        (code >= 0x3040 && code <= 0x30FF) ||
        // 全角字符
        (code >= 0xFF00 && code <= 0xFFEF) ||
        // 韩文
        (code >= 0xAC00 && code <= 0xD7AF) ||
        // CJK 扩展 A
        (code >= 0x3400 && code <= 0x4DBF)) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  }

  /**
   * 使颜色变亮
   * @private
   * @param {string} hex - 十六进制颜色代码
   * @param {number} amount - 变亮程度（0-1）
   * @returns {string} 变亮后的十六进制颜色
   */
  static #lightenColor(hex, amount) {
    const color = hex.replace('#', '');
    const num = parseInt(color, 16);
    const r = Math.min(255, Math.floor((num >> 16) + (255 - (num >> 16)) * amount));
    const g = Math.min(255, Math.floor(((num >> 8) & 0x00FF) + (255 - ((num >> 8) & 0x00FF)) * amount));
    const b = Math.min(255, Math.floor((num & 0x0000FF) + (255 - (num & 0x0000FF)) * amount));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  /**
   * 创建格式化的日志 ID（仅用于控制台输出）
   * @param {string|*} id - 日志 ID
   * @returns {string} 格式化的日志 ID
   */
  static makeLogID(id) {
    const logCfg = runtimeConfig.agt?.logging || {};
    const cacheKey = `logid_${id}_${logCfg.color || 'default'}_${logCfg.idFiller || '·'}`;
    const cached = RuntimeUtil.cache(cacheKey);
    if (cached) return cached;

    const targetLength = logCfg.idLength || 16;
    const filler = logCfg.idFiller || '·';
    const currentTheme = logCfg.color || 'default';
    const chalkInstance = chalk || globalThis.logger?.chalk;

    if (!id && !logCfg.align) {
      return RuntimeUtil.cache(cacheKey, "", 60000);
    }

    const idStr = id ? String(id) : (logCfg.align || "XRKAGT");
    const displayWidth = RuntimeUtil.#getDisplayWidth(idStr);

    // 纯文本模式（没有 chalk）
    if (!chalkInstance) {
      let plainContent;
      if (displayWidth > targetLength) {
        let truncated = '';
        let currentWidth = 0;
        for (const char of idStr) {
          const charWidth = RuntimeUtil.#getDisplayWidth(char);
          if (currentWidth + charWidth + 2 > targetLength) break;
          truncated += char;
          currentWidth += charWidth;
        }
        plainContent = truncated + '..';
      } else {
        const totalPadding = targetLength - displayWidth;
        const leftPad = Math.floor(totalPadding / 2);
        const rightPad = totalPadding - leftPad;
        plainContent = filler.repeat(leftPad) + idStr + filler.repeat(rightPad);
      }
      return RuntimeUtil.cache(cacheKey, `[${plainContent}]`, 60000);
    }

    // 彩色模式
    const idColors = RuntimeUtil.idColorSchemes[currentTheme] || RuntimeUtil.idColorSchemes.default;
    let result = chalkInstance.hex(idColors[0])('[');

    let fullContent = '';
    let isTruncated = false;
    let leftPadCount = 0;
    let rightPadCount = 0;

    if (displayWidth > targetLength) {
      let truncated = '';
      let currentWidth = 0;
      const maxWidth = targetLength - 2;

      for (const char of idStr) {
        const charWidth = RuntimeUtil.#getDisplayWidth(char);
        if (currentWidth + charWidth > maxWidth) break;
        truncated += char;
        currentWidth += charWidth;
      }

      fullContent = truncated + '..';
      isTruncated = true;
    } else if (displayWidth === targetLength) {
      fullContent = idStr;
    } else {
      const totalPadding = targetLength - displayWidth;
      leftPadCount = Math.floor(totalPadding / 2);
      rightPadCount = totalPadding - leftPadCount;

      fullContent = filler.repeat(leftPadCount) + idStr + filler.repeat(rightPadCount);
    }

    if (!isTruncated && leftPadCount > 0) {
      const leftPadding = filler.repeat(leftPadCount);
      result += RuntimeUtil.#applyGradientToString(leftPadding, idColors, chalkInstance, true);
    }

    const mainContent = isTruncated ? fullContent : idStr;
    result += RuntimeUtil.#applyGradientToString(mainContent, idColors, chalkInstance, false);

    if (!isTruncated && rightPadCount > 0) {
      const rightPadding = filler.repeat(rightPadCount);
      result += RuntimeUtil.#applyGradientToString(rightPadding, idColors, chalkInstance, true);
    }

    result += chalkInstance.hex(idColors[idColors.length - 1])(']');

    return RuntimeUtil.cache(cacheKey, result, 60000);
  }

  /**
   * 对字符串字符应用渐变颜色
   * @private
   * @param {string} text - 要着色的文本
   * @param {Array<string>} colors - 颜色数组
   * @param {Object} chalkInstance - Chalk 实例
   * @param {boolean} [lightMode=false] - 使用变亮的颜色
   * @returns {string} 着色后的字符串
   */
  static #applyGradientToString(text, colors, chalkInstance, lightMode = false) {
    if (!text || !colors?.length || !chalkInstance) return text;

    const chars = Array.from(text);
    const colorsToUse = lightMode ?
      colors.map(c => RuntimeUtil.#lightenColor(c, 0.6)) :
      colors;

    if (chars.length === 1) {
      return chalkInstance.hex(colorsToUse[Math.floor(colorsToUse.length / 2)])(text);
    }

    let result = '';
    const step = (colorsToUse.length - 1) / Math.max(1, chars.length - 1);

    for (let i = 0; i < chars.length; i++) {
      const colorIndex = Math.min(Math.floor(i * step), colorsToUse.length - 1);
      const char = chars[i];
      result += chalkInstance.hex(colorsToUse[colorIndex])(char);
    }

    return result;
  }

  /**
   * 创建格式化的日志消息（仅格式化，不写入文件）
   * @param {string} [level='info'] - 日志级别
   * @param {string|Array} msg - 要记录的消息
   * @param {string|*} [id] - 日志 ID
   * @param {boolean} [trace=false] - 包含堆栈跟踪
   * @returns {string} 格式化的日志消息
   */
  /**
   * 标准化日志记录
   * 
   * 日志级别说明：
   * - trace: 详细的执行跟踪，仅用于深度调试
   * - debug: 调试信息，用于开发时排查问题（内部状态、变量值、执行流程）
   * - info: 一般信息，用户可见的重要操作和状态（启动、完成、关键步骤）
   * - warn: 警告信息，可能的问题但不影响运行
   * - error: 错误信息，需要关注的问题
   * - fatal: 致命错误，可能导致系统崩溃
   * 
   * debug vs info 区别：
   * - debug: 技术细节、内部实现、开发调试信息（如：函数调用、变量值、解析过程）
   * - info: 业务逻辑、用户操作、系统状态（如：工作流启动、任务完成、API调用）
   */
  static makeLog(level = "info", msg, id, trace = false) {
    const validLevels = ["trace", "debug", "info", "warn", "error", "fatal", "mark", "success", "tip"];
    level = validLevels.includes(level) ? level : "info";

    const configLogLevel = runtimeConfig.agt?.logging?.level || "info";
    const levelPriorities = {
      "trace": 0,
      "debug": 1,
      "info": 2,
      "mark": 2,
      "success": 2,
      "tip": 2,
      "warn": 3,
      "error": 4,
      "fatal": 5
    };

    const currentPriority = levelPriorities[level] ?? 2;
    const configPriority = levelPriorities[configLogLevel] ?? 2;

    // 如果日志级别低于配置级别，直接返回（不输出）
    if (currentPriority < configPriority) {
      return "";
    }

    const formattedId = id !== false ? RuntimeUtil.makeLogID(id !== undefined ? id : "") : "";
    const messages = Array.isArray(msg) ? msg : [msg];
    const logParts = [];

    if (formattedId) {
      logParts.push(formattedId);
    }

    for (const item of messages) {
      if (item == null) {
        logParts.push(String(item));
      } else if (typeof item === "object") {
        try {
          const objectOptions = runtimeConfig.agt?.logging?.object || {};
          const inspectOptions = {
            depth: objectOptions.depth || 10,
            colors: false,
            showHidden: objectOptions.showHidden || false,
            showProxy: objectOptions.showProxy || false,
            getters: objectOptions.getters || false,
            breakLength: objectOptions.breakLength || 100,
            maxArrayLength: objectOptions.maxArrayLength || 100,
            maxStringLength: objectOptions.maxStringLength || 1000
          };

          try {
            logParts.push(util.inspect(item, inspectOptions));
          } catch {
            logParts.push(JSON.stringify(item, RuntimeUtil.getCircularReplacer(), 2));
          }
        } catch {
          try {
            logParts.push(JSON.stringify(item, RuntimeUtil.getCircularReplacer()));
          } catch {
            logParts.push("[Object]");
          }
        }
      } else {
        logParts.push(String(item));
      }
    }

    let logMessage = logParts.join(" ");
    // warn/error 多留上下文便于排障；info/debug 仍截断防刷屏
    const logCfg = runtimeConfig.agt?.logging || {};
    const isHot = level === 'warn' || level === 'error' || level === 'fatal';
    const maxLength = typeof logCfg.maxLength === 'number'
      ? logCfg.maxLength
      : (isHot ? 16000 : 5000);
    const preview = typeof logCfg.truncateHead === 'number'
      ? logCfg.truncateHead
      : (isHot ? 6000 : 1000);
    const suffix = typeof logCfg.truncateTail === 'number'
      ? logCfg.truncateTail
      : (isHot ? 4000 : 1000);

    if (logMessage.length > maxLength) {
      logMessage = `${logMessage.slice(0, preview)}... [截断 ${logMessage.length} 字符] ...${logMessage.slice(-suffix)}`;
    }

    const logger = globalThis.logger;
    try {
      if (logger && typeof logger[level] === 'function') {
        logger[level](logMessage);
        if (trace && typeof logger.trace === 'function') {
          const stack = new Error().stack.split("\n").slice(2).join("\n");
          logger.trace(`堆栈跟踪:\n${stack}`);
        }
      } else {
        console.log(`[${level.toUpperCase()}] ${logMessage}`);
      }
    } catch {
      console.log(`[${level.toUpperCase()}] ${logMessage}`);
    }

    return logMessage;
  }

  /**
   * 获取 JSON.stringify 的循环引用替换器
   * @returns {Function} 替换器函数
   */
  static getCircularReplacer() {
    const seen = new WeakSet();

    return (key, value) => {
      if (value == null) return value;

      switch (typeof value) {
        case "function":
          return `[Function: ${value.name || "anonymous"}]`;
        case "bigint":
          return value.toString();
        case "object":
          if (seen.has(value)) return "[循环引用]";
          seen.add(value);

          if (Error.isError(value)) {
            return {
              name: value.name,
              message: value.message,
              stack: value.stack
            };
          }
          if (value instanceof Map) {
            return {
              dataType: "Map",
              value: Array.from(value.entries())
            };
          }
          if (value instanceof Set) {
            return {
              dataType: "Set",
              value: Array.from(value.values())
            };
          }
          if (Buffer.isBuffer(value)) {
            return RuntimeUtil.StringOrBuffer(value, true);
          }
          break;
      }

      return value;
    };
  }

  // ========== 文件系统操作 ==========

  /**
   * 获取文件统计信息
   * @param {string} filePath - 文件路径
   * @returns {Promise<fs.Stats|false>} 文件统计信息或 false（如果不存在）
   */
  static async fsStat(filePath) {
    if (!filePath || !isPathLike(filePath)) return false;

    try {
      return await fs.stat(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT' && globalThis.logger?.trace) {
        const s = String(filePath);
        const hint = s.length <= 120 ? s : `${s.slice(0, 48)}…[+${s.length - 48} chars]`;
        globalThis.logger.trace(["获取", hint, "统计信息错误", err.code || err.message]);
      }
      return false;
    }
  }

  /**
   * 递归创建目录
   * @param {string} dir - 目录路径
   * @param {Object} [opts={recursive: true}] - 选项
   * @returns {Promise<boolean>} 成功状态
   */
  static async mkdir(dir, opts = { recursive: true }) {
    if (!dir) return false;

    try {
      await fs.mkdir(dir, opts);
      return true;
    } catch (err) {
      if (err.code === "EEXIST") return true;
      if (globalThis.logger?.error) {
        globalThis.logger.error(["创建", dir, "错误", err.message]);
      }
      return false;
    }
  }

  /**
   * 删除文件或目录
   * @param {string} file - 要删除的路径
   * @returns {Promise<boolean>} 成功状态
   */
  static async rm(file) {
    if (!file) return false;

    try {
      await fs.rm(file, { force: true, recursive: true });
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      if (globalThis.logger?.error) {
        globalThis.logger.error(["删除", file, "错误", err.message]);
      }
      return false;
    }
  }

  /**
   * 读取文件内容
   * @param {string} filePath - 文件路径
   * @param {string} [encoding='utf8'] - 文件编码
   * @returns {Promise<string|Buffer>} 文件内容
   * @throws {Error} 如果文件路径为空
   */
  static async readFile(filePath, encoding = "utf8") {
    if (!filePath) throw new Error("文件路径为空");
    return fs.readFile(filePath, encoding);
  }

  /**
   * 将数据写入文件
   * @param {string} filePath - 文件路径
   * @param {string|Buffer} data - 要写入的数据
   * @param {Object} [opts={}] - 写入选项
   * @returns {Promise<void>}
   * @throws {Error} 如果文件路径为空
   */
  static async writeFile(filePath, data, opts = {}) {
    if (!filePath) throw new Error("文件路径为空");
    await RuntimeUtil.mkdir(path.dirname(filePath));
    return fs.writeFile(filePath, data, opts);
  }

  /**
   * 检查文件是否存在
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>} 存在状态
   */
  static async fileExists(filePath) {
    if (!filePath || !isPathLike(filePath)) return false;

    try {
      await fs.access(filePath, fsSync.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }


  /**
   * 查找匹配模式的文件
   * @param {string} pattern - Glob 模式
   * @param {Object} [opts={}] - Glob 选项
   * @param {boolean} [opts.force=false] - 即使不是模式也强制使用 glob
   * @param {boolean} [opts.dot=true] - 包含点文件
   * @param {boolean} [opts.absolute=false] - 返回绝对路径
   * @param {string} [opts.cwd=paths.root] - 当前工作目录
   * @param {Array} [opts.ignore=[]] - 要忽略的模式
   * @param {boolean} [opts.onlyFiles=true] - 仅匹配文件
   * @returns {Promise<Array<string>>} 匹配的文件路径
   */
  static async glob(pattern, opts = {}) {
    if (!pattern) return [];

    if (!opts.force && !RuntimeUtil.regexCache.globPattern.test(pattern)) {
      const stat = await RuntimeUtil.fsStat(pattern);
      return stat ? [pattern] : [];
    }

    try {
      const globOptions = {
        dot: opts.dot !== false,
        absolute: opts.absolute === true,
        cwd: opts.cwd || paths.root,
        ignore: opts.ignore || [],
        onlyFiles: opts.onlyFiles !== false,
        ...opts
      };

      const files = await globLib(pattern, globOptions);
      return Array.isArray(files) ? files : Array.from(files);
    } catch (err) {
      if (globalThis.logger?.error) {
        globalThis.logger.error(["匹配", pattern, "错误", err.message]);
      }
      return [];
    }
  }

  // ========== 缓冲区和文件处理 ==========

  /**
   * 将数据转换为缓冲区
   * @param {*} data - 要转换的数据
   * @param {Object} [opts={}] - 选项
   * @param {number} [opts.size] - 保存到文件前的最大缓冲区大小
   * @param {boolean} [opts.http] - 如果是 HTTP URL 则保持为 URL
   * @param {boolean} [opts.file] - 保持为文件路径
   * @param {number} [opts.timeout=30000] - 获取超时
   * @param {Object} [opts.fetchOptions] - 额外的 fetch 选项
   * @returns {Promise<Buffer|string>} 缓冲区或文件/数据 URL
   */
  static async Buffer(data, opts = {}) {
    if (Buffer.isBuffer(data)) {
      return opts.size && data.length > opts.size ?
        await RuntimeUtil.#saveBufferToTempFile(data) : data;
    }

    const dataStr = String(data);

    // 处理 base64
    if (dataStr.startsWith("base64://")) {
      try {
        const buffer = Buffer.from(Uint8Array.fromBase64(dataStr.slice(9)));
        return opts.size && buffer.length > opts.size ?
          await RuntimeUtil.#saveBufferToTempFile(buffer) : buffer;
      } catch {
        return Buffer.alloc(0);
      }
    }

    // 处理 URL
    if (RuntimeUtil.regexCache.url.test(dataStr)) {
      if (opts.http) return dataStr;

      try {
        const response = await fetch(dataStr, {
          signal: AbortSignal.timeout(opts.timeout || 30000),
          ...opts.fetchOptions
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        return opts.size && buffer.length > opts.size ?
          await RuntimeUtil.#saveBufferToTempFile(buffer) : buffer;
      } catch (err) {
        if (globalThis.logger?.error) {
          globalThis.logger.error(["获取 URL 内容错误", dataStr, err.message]);
        }
        return Buffer.alloc(0);
      }
    }

    const inlineBinary = inlineBinaryFromRef(dataStr);
    if (inlineBinary) {
      return opts.size && inlineBinary.length > opts.size
        ? await RuntimeUtil.#saveBufferToTempFile(inlineBinary) : inlineBinary;
    }

    // 处理文件路径
    const filePath = dataStr.replace(/^file:\/\//, "");
    if (isPathLike(filePath)) {
      const stat = await RuntimeUtil.fsStat(filePath);
      if (stat) {
        if (opts.file) return `file://${path.resolve(filePath)}`;

        try {
          const buffer = await fs.readFile(filePath);
          return opts.size && buffer.length > opts.size ?
            `file://${path.resolve(filePath)}` : buffer;
        } catch {
          return Buffer.alloc(0);
        }
      }
    }

    return Buffer.from(dataStr);
  }

  /**
   * 将缓冲区保存到临时文件
   * @private
   * @param {Buffer} buffer - 要保存的缓冲区
   * @returns {Promise<string>} 文件 URL 或数据 URL
   */
  static async #saveBufferToTempFile(buffer) {
    const tempDir = paths.trash;

    try {
      // trash 目录已在 ensureBaseDirs 中创建，无需重复创建
      const filename = ulid();
      const filePath = path.join(tempDir, filename);
      await fs.writeFile(filePath, buffer);

      setTimeout(() => RuntimeUtil.rm(filePath).catch(() => { }), 60000);

      return `file://${path.resolve(filePath)}`;
    } catch {
      return `data:application/octet-stream;base64,${buffer.toBase64()}`;
    }
  }

  /**
   * 从缓冲区检测文件类型
   * @param {Object} data - 文件数据对象
   * @param {string} [data.name] - 文件名
   * @param {string|Buffer} data.file - 文件内容
   * @param {Object} [opts={}] - 选项
   * @param {number} [opts.size] - 最大大小限制
   * @returns {Promise<Object>} 文件类型信息
   */
  static async fileType(data, opts = {}) {
    if (!data) return {
      name: "未知",
      type: { ext: "未知" },
      md5: "",
      url: "",
      buffer: null
    };

    const file = {
      name: data.name || "",
      url: "",
      buffer: null,
      type: { ext: "未知" },
      md5: ""
    };

    try {
      if (Buffer.isBuffer(data.file)) {
        file.url = data.name || "Buffer";
        file.buffer = data.file;
      } else if (typeof data.file === 'string') {
        file.url = data.file.replace(/^base64:\/\/.*/, "base64://...");
        file.buffer = await RuntimeUtil.Buffer(data.file, { ...opts, size: undefined });
      }

      if (Buffer.isBuffer(file.buffer) && file.buffer.length > 0) {
        const fileTypeResult = await fileTypeFromBuffer(file.buffer).catch(() => null);
        if (fileTypeResult) {
          file.type = fileTypeResult;
        } else {
          const ext = path.extname(file.url).slice(1);
          file.type = { ext: ext || "未知" };
        }

        file.md5 = md5(file.buffer);
        file.name = file.name || `${Date.now().toString(36)}.${file.md5.slice(0, 8)}.${file.type.ext}`;

        if (opts.size && file.buffer.length > opts.size) {
          file.buffer = await RuntimeUtil.Buffer(data.file, opts);
        }
      }
    } catch (err) {
      if (globalThis.logger?.error) {
        globalThis.logger.error(["文件类型检测错误", err.message]);
      }
    }

    file.name = file.name || `${Date.now().toString(36)}-未知`;
    return file;
  }

  /**
   * 将文件转换为可访问的 URL
   * @param {string|Buffer} file - 要转换的文件
   * @param {Object} [opts={}] - 选项
   * @param {string} [opts.name] - 文件名
   * @param {boolean} [opts.returnPath] - 返回路径和 URL
   * @param {string} [opts.baseUrl] - 服务基础 URL
   * @param {Object} [opts.fetchOptions] - Fetch 选项
   * @returns {Promise<string|Object>} URL 或带路径的 URL
   * @throws {Error} 如果转换失败
   */
  static async fileToUrl(file, opts = {}) {
    const options = {
      name: opts.name || null,
      time: ((runtimeConfig.agt?.files?.urlTime || 60) * 60000),
      times: runtimeConfig.agt?.files?.urlTimes || 5,
      returnPath: opts.returnPath === true,
      baseUrl: opts.baseUrl,
      fetchOptions: opts.fetchOptions
    };

    try {
      const mediaDir = path.join(paths.data, "media");
      // media 目录已在 ensureBaseDirs 中创建，无需重复创建

      let fileBuffer;
      let fileName = options.name || ulid();

      if (Buffer.isBuffer(file)) {
        fileBuffer = file;
      } else if (typeof file === "string") {
        if (file.startsWith("base64://")) {
          fileBuffer = Buffer.from(Uint8Array.fromBase64(file.slice(9)));
        } else if (RuntimeUtil.regexCache.url.test(file)) {
          const response = await fetch(file, {
            signal: AbortSignal.timeout(30000),
            ...options.fetchOptions
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          fileBuffer = Buffer.from(await response.arrayBuffer());

          const contentType = response.headers.get('content-type')?.split(';')[0];
          const ext = contentType ? RuntimeUtil.mimeToExtMap.get(contentType) : '';
          fileName = options.name || path.basename(file) || `${ulid()}${ext || '.file'}`;
        } else if (await RuntimeUtil.fileExists(file)) {
          fileBuffer = await fs.readFile(file);
          fileName = options.name || path.basename(file);
        } else {
          throw new Error(`无效的文件路径: ${file}`);
        }
      } else {
        throw new Error("不支持的文件类型");
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        throw new Error("获取文件数据失败");
      }

      if (!path.extname(fileName)) {
        try {
          const fileType = await fileTypeFromBuffer(fileBuffer);
          fileName += `.${fileType?.ext || 'file'}`;
        } catch {
          fileName += '.file';
        }
      }

      const finalFileName = `${ulid()}_${fileName}`;
      const destPath = path.join(mediaDir, finalFileName);

      await fs.writeFile(destPath, fileBuffer);

      setTimeout(() => RuntimeUtil.rm(destPath).catch(() => { }), options.time);

      const port = runtimeConfig.port || 8086;
      const baseUrl = options.baseUrl || runtimeConfig.server?.server?.url || `http://localhost:${port}`;
      const url = `${baseUrl}/media/${finalFileName}`;

      if (options.returnPath) {
        return { url, path: path.resolve(destPath), name: finalFileName };
      }

      return url;
    } catch (err) {
      if (globalThis.logger?.error) {
        globalThis.logger.error(["文件转 URL 错误", err.message]);
      }
      throw err;
    }
  }

  // ========== 实用函数 ==========

  /**
   * 执行系统命令
   * @param {string|Array} cmd - 要执行的命令
   * @param {Object} [opts={}] - 执行选项
   * @param {boolean} [opts.quiet=false] - 抑制日志
   * @param {number} [opts.timeout=60000] - 超时（毫秒）
   * @returns {Promise<Object>} 执行结果
   */
  static async exec(cmd, opts = {}) {
    if (!cmd) return { error: new Error("命令为空"), stdout: "", stderr: "" };

    const cmdStr = String(cmd);
    const startTime = Date.now();

    if (!opts.quiet && globalThis.logger?.mark) {
      globalThis.logger.mark(cmdStr, "命令");
    }

    const execOpts = {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts.timeout || 60000,
      windowsHide: true,
      ...opts
    };

    let error = null;
    let stdout = "";
    let stderr = "";
    let raw = { stdout: null, stderr: null };

    try {
      const out = Array.isArray(cmd)
        ? await execFile(cmd[0], cmd.slice(1), execOpts)
        : await exec(cmdStr, execOpts);
      raw = { stdout: out.stdout, stderr: out.stderr };
      stdout = out.stdout?.toString() || "";
      stderr = out.stderr?.toString() || "";
    } catch (err) {
      error = normalizeError(err);
      raw = { stdout: err.stdout, stderr: err.stderr };
      stdout = err.stdout?.toString?.() || "";
      stderr = err.stderr?.toString?.() || "";
    }

    const duration = RuntimeUtil.getTimeDiff(startTime);
    const result = {
      error,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      raw,
      duration
    };

    if (!opts.quiet && globalThis.logger?.mark) {
      let logMessage = `${cmdStr} [完成 ${duration}]`;
      if (result.stdout) logMessage += `\n${result.stdout}`;
      if (result.stderr) logMessage += `\n${result.stderr}`;
      globalThis.logger.mark(logMessage, "命令");
    }

    if (error && !opts.quiet && globalThis.logger?.error) {
      globalThis.logger.error(error, "命令");
    }

    return result;
  }

  /**
   * 睡眠/延迟执行
   * @param {number} time - 延迟时间（毫秒）
   * @param {Promise} [promise] - 可选的要竞争的 Promise
   * @returns {Promise<*>} 超时符号或 Promise 结果
   */
  static sleep(time, promise) {
    if (!time || time <= 0) return Promise.resolve(Symbol("timeout"));

    const sleepPromise = new Promise(resolve =>
      setTimeout(() => resolve(Symbol("timeout")), time)
    );

    return promise instanceof Promise ?
      Promise.race([promise, sleepPromise]) : sleepPromise;
  }

  /**
   * 等待 EventEmitter 的事件
   * @param {EventEmitter} emitter - 事件发射器
   * @param {string} event - 要等待的事件名称
   * @param {string} [errorEvent] - 错误事件名称
   * @param {number} [timeout] - 超时（毫秒）
   * @returns {Promise<Array>} 事件参数
   * @throws {Error} 错误或超时时抛出
   */
  static promiseEvent(emitter, event, errorEvent, timeout) {
    if (!emitter || !event) {
      return Promise.reject(new Error("无效的参数"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId;

      const cleanup = () => {
        emitter.off(event, onSuccess);
        if (errorEvent) emitter.off(errorEvent, onError);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const onSuccess = (...args) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(args);
      };

      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err || new Error(`${errorEvent} 事件触发`));
      };

      emitter.once(event, onSuccess);
      if (errorEvent) emitter.once(errorEvent, onError);

      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`等待事件 ${event} 超时`));
        }, timeout);
      }
    });
  }

  /**
   * 获取格式化的时间差
   * @param {number} [time1=Date.now()] - 开始时间
   * @param {number} [time2=Date.now()] - 结束时间
   * @returns {string} 格式化的时间差
   */
  static getTimeDiff(time1 = Date.now(), time2 = Date.now()) {
    const totalSeconds = Math.abs(time2 - time1) / 1000;

    if (totalSeconds < 0.1) {
      return `${Math.round(Math.abs(time2 - time1))}ms`;
    }

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = (totalSeconds % 60).toFixed(3);

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (parseFloat(seconds) > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(" ");
  }

  /**
   * 格式化文件大小为人类可读格式
   * @param {number} bytes - 字节大小
   * @param {number} [decimals=2] - 小数位数
   * @returns {string} 格式化的大小
   */
  static formatFileSize(bytes, decimals = 2) {
    if (bytes === 0) return '0 字节';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['字节', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }


  /**
   * 深度克隆对象
   * @param {*} obj - 要克隆的对象
   * @param {WeakMap} [cache=new WeakMap()] - 循环引用缓存
   * @returns {*} 克隆的对象
   */
  static deepClone(obj, cache = new WeakMap()) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj);
    if (obj instanceof Array) return obj.map(item => RuntimeUtil.deepClone(item, cache));
    if (obj instanceof RegExp) return new RegExp(obj);
    if (obj instanceof Map) {
      const cloned = new Map();
      obj.forEach((value, key) => {
        cloned.set(key, RuntimeUtil.deepClone(value, cache));
      });
      return cloned;
    }
    if (obj instanceof Set) {
      const cloned = new Set();
      obj.forEach(value => {
        cloned.add(RuntimeUtil.deepClone(value, cache));
      });
      return cloned;
    }

    if (cache.has(obj)) return cache.get(obj);

    const clonedObj = Object.create(Object.getPrototypeOf(obj));
    cache.set(obj, clonedObj);

    for (const key in obj) {
      clonedObj[key] = RuntimeUtil.deepClone(obj[key], cache);
    }

    return clonedObj;
  }

  /**
   * 深度合并对象
   * @param {Object} target - 目标对象
   * @param {...Object} sources - 源对象
   * @returns {Object} 合并后的对象
   */
  static deepMerge(target, ...sources) {
    if (!sources.length) return target;

    const source = sources.shift();

    if (RuntimeUtil.isObject(target) && RuntimeUtil.isObject(source)) {
      for (const key in source) {
        if (RuntimeUtil.isObject(source[key])) {
          if (!target[key]) Object.assign(target, { [key]: {} });
          RuntimeUtil.deepMerge(target[key], source[key]);
        } else {
          Object.assign(target, { [key]: source[key] });
        }
      }
    }

    return RuntimeUtil.deepMerge(target, ...sources);
  }

  /**
   * 检查值是否为普通对象
   * @param {*} item - 要检查的值
   * @returns {boolean} 是否为普通对象
   */
  static isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }


  // ========== 消息处理 ==========

  /**
   * 从消息中提取文本内容
   * @param {string|Array|Object} message - 要提取的消息
   * @returns {string} 提取的文本内容
   */
  static extractTextContent(message) {
    if (!message) return "";

    if (typeof message === "string") return message.trim();

    if (Array.isArray(message)) {
      return message
        .filter(m => m && (m.type === "text" || typeof m.text === "string"))
        .map(m => m.text || "")
        .join("")
        .trim();
    }

    if (typeof message === "object") {
      if (message.text) return String(message.text).trim();
      if (typeof message.message === "string") return message.message.trim();
      if (Array.isArray(message.message)) return RuntimeUtil.extractTextContent(message.message);
    }

    return "";
  }

  /**
   * 创建聊天记录
   * @param {Object} e - 事件对象
   * @param {Array} messages - 消息数组
   * @param {string} title - 记录标题
   * @param {string|Array} [description=['AgentRuntime 消息']] - 描述
   * @returns {Promise<boolean>} 成功状态
   */
  static async makeChatRecord(e, messages, title, description = ["AgentRuntime 消息"]) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      const isDevice = e.isDevice || e.tasker === 'device' || e.post_type === 'device';

      if (isDevice && e.reply) {
        const descText = Array.isArray(description) ? description.join(' | ') : (typeof description === 'string' ? description : String(description ?? ''));
        
        // 对于web客户端，使用转发消息格式发送聊天记录
        const bot = e.bot || {};
        const nickname = bot.nickname || "AgentRuntime";
        const user_id = bot.uin || e.self_id || 0;
        const currentTime = Math.floor(Date.now() / 1000);
        
        // 格式化消息为转发消息格式（OneBot标准格式）
        const forwardMessages = messages
          .map((msg, idx) => {
            const text = typeof msg === 'string' ? msg : (msg.message || msg.content || String(msg));
            if (!text || !text.trim()) return null;
            
            return {
              type: 'node',
              data: {
                user_id: user_id,
                nickname: nickname,
                time: currentTime + idx,
                content: [{ type: 'text', data: { text: text.trim() } }]
              }
            };
          })
          .filter(msg => msg !== null && msg.data && msg.data.content && msg.data.content.length > 0);
        
        if (forwardMessages.length === 0) {
          // 如果没有有效消息，降级为普通文本消息
          const firstMsg = messages[0];
          const text = typeof firstMsg === 'string' ? firstMsg : (firstMsg?.message ?? firstMsg?.content ?? String(firstMsg ?? ''));
          if (text && text.trim()) {
            return await e.reply(text.trim());
          }
          return false;
        }
        
        // 使用转发消息格式发送（OneBot标准：forward segment包含data.messages）
        const forwardSegment = {
          type: 'forward',
          data: {
            messages: forwardMessages
          }
        };
        
        const replyData = {
          segments: [forwardSegment],
          title: title || '',
          description: descText || ''
        };
        
        return await e.reply(replyData);
      }

      const botImpl = String(e.bot?.version?.id || e.tasker || '').toUpperCase();
      if (botImpl === 'ICQQ') {
        const bot = e.bot || {};
        const nickname = bot.nickname || "AgentRuntime";
        const user_id = bot.uin || 0;
        const currentTime = Math.floor(Date.now() / 1000);

        const formatMessages = messages.map((msg, idx) => ({
          message: msg,
          nickname,
          user_id,
          time: currentTime + idx + 1,
        }));

        return await RuntimeUtil.makeMsg(e, formatMessages, title, description);
      } else if (common?.makeForwardMsg) {
        const forwardMsg = await common.makeForwardMsg(e, messages, title);
        await e.reply(forwardMsg);
        return true;
      } else {
        return await RuntimeUtil.makeMsg(e, messages, title, description);
      }
    } catch (err) {
      if (globalThis.logger?.error) {
        globalThis.logger.error(["创建聊天记录错误", err.message]);
      }
      try {
        const simpleMessage = typeof messages[0] === 'string' ? messages[0] : '[复杂消息]';
        await e.reply(`${title || '消息'}: ${simpleMessage}${messages.length > 1 ? ' (还有更多)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * 制作转发消息
   * @param {Object} e - 事件对象
   * @param {Array} messages - 消息数组
   * @param {string} title - 消息标题
   * @param {string} description - 消息描述
   * @returns {Promise<boolean>} 成功状态
   */
  static async makeMsg(e, messages, title, description) {
    if (!e) return false;

    messages = Array.isArray(messages) ? messages : (messages ? [messages] : []);
    if (messages.length === 0) return false;

    try {
      const finalSummary = moment().format("HH:mm:ss.SSS.");

      const rawObj = e.group?.makeForwardMsg ? e.group :
        e.friend?.makeForwardMsg ? e.friend :
          e.makeForwardMsg ? e : null;

      if (!rawObj) throw new Error("找不到 makeForwardMsg 方法");

      const ngm = await rawObj.makeForwardMsg(messages);

      if (ngm?.data?.meta) {
        if (!ngm.data.meta.detail) ngm.data.meta.detail = {};
        Object.assign(ngm.data.meta.detail, {
          news: [{ text: description || title || '查看详情' }],
          source: title || '转发消息',
          summary: finalSummary
        });

        if (ngm.data.prompt) {
          ngm.data.prompt = title || '转发消息';
        }
      }

      await e.reply(ngm);
      if (globalThis.logger?.mark) {
        globalThis.logger.mark(`『${title || '转发消息'}』已发送`);
      }
      return true;

    } catch (error) {
      if (globalThis.logger?.error) {
        globalThis.logger.error(["转发消息错误", error.message]);
      }

      try {
        const firstMsg = Array.isArray(messages[0]) ? messages[0].join("\n") :
          typeof messages[0] === 'object' ?
            (messages[0].message || messages[0].content || JSON.stringify(messages[0])) :
            String(messages[0]);

        await e.reply(`${title ? `【${title}】\n` : ''}${firstMsg}${messages.length > 1 ? '\n(消息太长，已省略)' : ''}`);
        return true;
      } catch {
        return false;
      }
    }
  }

}

export async function 制作聊天记录(e, messages, title, description) {
  return RuntimeUtil.makeChatRecord(e, messages, title, description);
}