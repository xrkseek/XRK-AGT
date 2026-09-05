// @ts-nocheck
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { exec } from 'node:child_process'
import moment from 'moment'
import crypto from 'crypto'
import zlib from 'zlib'
import querystring from 'querystring'
import url from 'url'
import stream from 'stream'
import os from 'os'
import vm from 'vm'
import util from 'util'
import { EventEmitter } from 'events'
import common from '#utils/common.js'
import runtimeConfig from '#infrastructure/config/config.js'
import { 制作聊天记录 } from '#utils/runtime-util.js'

const ROOT_PATH = process.cwd();

/**
 * 工具配置管理类
 */
class ToolsConfig {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = {};
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = YAML.parse(fs.readFileSync(this.configPath, 'utf8'));
      } else {
        this.config = {
          permission: 'master',
          blacklist: true,
          ban: ['rm -rf', 'sudo', 'shutdown', 'reboot'],
          shell: true,
          timeout: 300000,
          maxHistory: 100,
          updateInterval: 3000,
          maxOutputLength: 5000,
          maxObjectDepth: 4,
          circularDetection: true,
          printMode: 'full',
          saveChunkedOutput: true,
          jsExecutionMode: 'safe', // safe, enhanced, sandbox
          jsTimeout: 10000,
        };
        this.saveConfig();
      }
    } catch (error) {
      logger.error(`[终端工具] 配置文件加载失败: ${error.message}`);
    }
  }

  saveConfig() {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, YAML.stringify(this.config), 'utf8');
    } catch (error) {
      logger.error(`[终端工具] 配置文件保存失败: ${error.message}`);
    }
  }

  get(key, defaultValue) {
    return key in this.config ? this.config[key] : defaultValue;
  }

  set(key, value) {
    this.config[key] = value;
    this.saveConfig();
  }
}

/**
 * 终端命令处理类
 */
class TerminalHandler {
  constructor() {
    if (process.platform === 'win32') {
      this.formatPrompt = (cmd) =>
        `powershell -EncodedCommand ${Buffer.from(
          `$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${cmd}`,
          'utf-16le'
        ).toBase64()}`;
      this.formatOutput = (cmd, data) => data.replace(/\r\n/g, '\n').trim();
    } else {
      this.formatPrompt = (cmd) => cmd;
      this.formatOutput = (cmd, data) => data.trim();
    }

    this.outputDir = path.join(ROOT_PATH, 'data', 'terminal_output');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  isLongRunningCommand(cmd) {
    const longRunningPatterns = [
      /\bgit\s+clone\b/i,
      /\bgit\s+pull\b/i,
      /\bgit\s+push\b/i,
      /\bgit\s+fetch\b/i,
      /\bgit\s+log\b/i,
      /\bnpm\s+(install|update|ci|i)\b/i,
      /\byarn\s+(install|add)\b/i,
      /\bpnpm\s+(install|add)\b/i,
      /\bcurl\s+.*\s+-o\b/i,
      /\bwget\b/i,
      /\bpip\s+(install|download)\b/i,
      /\bapt\s+(update|upgrade|install)\b/i,
      /\byum\s+install\b/i,
      /\bcomposer\s+install\b/i,
      /\bmvn\s+install\b/i,
      /\bdownload\b/i,
      /\binstall\b/i,
      /\bdocker\s+(pull|build|compose)\b/i,
      /\bfind\s+.*\s+-exec\b/i,
      /\bgrep\s+-r\b/i,
      /\bscp\b/i,
      /\brsync\b/i,
      /\bcp\s+-r\b/i,
      /\bmv\s+-r\b/i,
    ];
    return longRunningPatterns.some((pattern) => pattern.test(cmd));
  }

  isGitCommand(cmd) {
    return /\bgit\b/.test(cmd);
  }

  saveOutputToFile(cmd, output) {
    try {
      const timestamp = moment().format('YYYYMMDD_HHmmss');
      const sanitizedCmd = cmd.replace(/[^a-z0-9]/gi, '_').substring(0, 20);
      const filename = `${timestamp}_${sanitizedCmd}.log`;
      const filepath = path.join(this.outputDir, filename);

      fs.writeFileSync(filepath, output, 'utf8');
      return filepath;
    } catch (error) {
      logger.error(`[终端工具] 保存输出到文件失败: ${error.message}`);
      return null;
    }
  }

  async execute(e, cmd, options, timeout = 300000) {
    const isLongRunning = this.isLongRunningCommand(cmd);
    const isGitCmd = this.isGitCommand(cmd);
    const updateInterval = config.get('updateInterval', 3000);
    const maxOutputLength = config.get('maxOutputLength', 5000);
    const saveChunkedOutput = config.get('saveChunkedOutput', true);

    if (isGitCmd) {
      if (cmd.includes('git log')) {
        if (!cmd.includes('-n') && !cmd.includes('--max-count')) {
          cmd = cmd.replace(/git log/, 'git log -n 30');
        }
      }

      if (cmd.includes('git status') || cmd.includes('git diff')) {
        cmd = cmd.replace(/git /, 'git -c color.ui=always ');
      }
    }

    if (isLongRunning) {
      await e.reply(
        `⏳ 开始执行命令: ${cmd}\n该命令可能需要较长时间，将实时更新执行进度...`
      );
    }

    return new Promise(async (resolve) => {
      const startTime = Date.now();
      const chunkedOutput = [];
      const command = exec(this.formatPrompt(cmd), {
        ...options,
        maxBuffer: 10 * 1024 * 1024
      });

      let stdout = '';
      let stderr = '';
      let lastUpdateTime = Date.now();
      let msgId = null;
      
      const updateOutput = async () => {
        if (Date.now() - lastUpdateTime < updateInterval) return;
        lastUpdateTime = Date.now();

        let currentOutput = stdout || stderr;
        if (saveChunkedOutput && currentOutput.trim()) {
          chunkedOutput.push(currentOutput.trim());
        }

        if (currentOutput.length > maxOutputLength) {
          currentOutput =
            '...(输出太长，仅显示最近部分)\n' +
            currentOutput.slice(-maxOutputLength);
        }

        if (currentOutput.trim()) {
          try {
            if (msgId) {
              try {
                (e.isGroup ? e.group : e.friend)?.recallMsg(msgId);
              } catch (error) {
                logger.debug(`[终端工具] 撤回消息失败: ${error.message}`);
              }
            }
            const msg = await 制作聊天记录(e, currentOutput.trim(), '⏳ 命令执行进行中', `${cmd} | 已执行: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`);

            if (msg && msg.message_id) {
              msgId = msg.message_id;
            }
          } catch (error) {
            logger.error(`[终端工具] 更新消息错误: ${error.message}`);
            try {
              const msg = await e.reply(`⏳ 命令执行进行中...\n执行时间: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`, true);
              if (msg && msg.message_id) {
                msgId = msg.message_id;
              }
            } catch (innerError) {
              logger.error(`[终端工具] 发送进度消息失败: ${innerError.message}`);
            }
          }
        }
      };

      command.stdout.on('data', (data) => {
        stdout += data.toString();
        if (isLongRunning) updateOutput();
      });

      command.stderr.on('data', (data) => {
        stderr += data.toString();
        if (isLongRunning) updateOutput();
      });

      const timer = setTimeout(() => {
        command.kill();
        resolve({
          success: false,
          message: `命令执行超时（${timeout / 1000}秒）`,
          code: 124,
          stdout,
          stderr,
          startTime,
          endTime: Date.now(),
        });
      }, timeout);

      command.on('close', async (code) => {
        clearTimeout(timer);
        logger.debug(`命令 "${cmd}" 返回代码: ${code}`);

        if (isLongRunning && msgId) {
          try {
            (e.isGroup ? e.group : e.friend)?.recallMsg(msgId);
          } catch (error) {
            logger.debug(`[终端工具] 无法撤回消息: ${error.message}`);
          }
        }

        let finalOutput = stdout || stderr;
        if (code !== 0 && stderr) {
          finalOutput = stderr;
        }

        if (saveChunkedOutput && chunkedOutput.length > 0) {
          const completeOutput = chunkedOutput.join('\n\n');
          if (completeOutput.length > maxOutputLength * 2) {
            const outputFile = this.saveOutputToFile(cmd, completeOutput);
            if (outputFile) {
              finalOutput += `\n\n[完整输出太长，已保存到文件: ${outputFile}]`;
            }
          }
        }

        let formattedOutput = this.formatOutput(cmd, finalOutput || (code === 0 ? '任务已完成，无返回' : `执行失败，返回代码: ${code}`));

        if (formattedOutput.length > maxOutputLength) {
          if (isGitCmd && formattedOutput.length > maxOutputLength * 1.5) {
            const outputFile = this.saveOutputToFile(cmd, formattedOutput);
            if (outputFile) {
              formattedOutput = formattedOutput.slice(0, maxOutputLength) +
                `\n\n... 输出太长 (${formattedOutput.length} 字符)，完整输出已保存到: ${outputFile}`;
            } else {
              formattedOutput = formattedOutput.slice(0, maxOutputLength) +
                `\n\n... 输出被截断 (共 ${formattedOutput.length} 字符)`;
            }
          } else {
            formattedOutput = formattedOutput.slice(0, maxOutputLength) +
              `\n\n... 输出被截断 (共 ${formattedOutput.length} 字符)`;
          }
        }

        resolve({
          success: code === 0,
          message: formattedOutput,
          code: code,
          stdout,
          stderr,
          startTime,
          endTime: Date.now(),
        });
      });
    });
  }
}

/**
 * 命令历史记录管理类
 */
class CommandHistory {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.history = [];
    this.historyFile = path.join(ROOT_PATH, 'data', 'tools_history.json');
    this.loadHistory();
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      }
    } catch (error) {
      logger.error(`[终端工具] 历史记录加载失败: ${error.message}`);
      this.history = [];
    }
  }

  saveHistory() {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history), 'utf8');
    } catch (error) {
      logger.error(`[终端工具] 历史记录保存失败: ${error.message}`);
    }
  }

  add(command, type, code) {
    this.history.unshift({
      command,
      type,
      timestamp: Date.now(),
      code,
    });
    if (this.history.length > this.maxSize) {
      this.history = this.history.slice(0, this.maxSize);
    }
    this.saveHistory();
  }

  get(limit = 10, type = null) {
    if (type) {
      return this.history.filter((item) => item.type === type).slice(0, limit);
    }
    return this.history.slice(0, limit);
  }

  clear() {
    this.history = [];
    this.saveHistory();
    return true;
  }
}

/**
 * 对象检查工具
 */
class ObjectInspector {
  constructor(options = {}) {
    this.options = {
      maxDepth: options.maxDepth || 4,
      circularDetection: options.circularDetection !== false,
      showPrototype: options.showPrototype !== false,
      showGettersSetters: options.showGettersSetters !== false,
      showFunctions: options.showFunctions !== false,
      maxArrayItems: options.maxArrayItems || 30,
      maxStringLength: options.maxStringLength || 200,
      maxPropertiesPerObject: options.maxPropertiesPerObject || 100,
    };
  }

  inspect(obj, name = 'Object') {
    if (obj === undefined) {
      return {
        name,
        type: 'undefined',
        value: String(obj),
        properties: [],
        methods: [],
      };
    }
    if (obj === null) {
      return {
        name,
        type: 'null',
        value: String(obj),
        properties: [],
        methods: [],
      };
    }

    if (typeof obj !== 'object' && typeof obj !== 'function') {
      return {
        name,
        type: typeof obj,
        value: this.formatValue(obj),
        properties: [],
        methods: [],
      };
    }

    const result = {
      name,
      type: this.getType(obj),
      properties: [],
      methods: [],
    };

    try {
      const seen = new WeakMap();
      this.collectPropertiesAndMethods(obj, result, seen, 0);
      result.propertyCount = result.properties.length;
      result.methodCount = result.methods.length;

      result.properties.sort((a, b) => {
        const sourceOrder = { 'own': 0, 'array': 1, 'proto': 2, 'circular': 3 };
        if (sourceOrder[a.from] !== sourceOrder[b.from]) {
          return sourceOrder[a.from] - sourceOrder[b.from];
        }
        return a.name.localeCompare(b.name);
      });

      result.methods.sort((a, b) => {
        const sourceOrder = { 'own': 0, 'proto': 1 };
        if (sourceOrder[a.from] !== sourceOrder[b.from]) {
          return sourceOrder[a.from] - sourceOrder[b.from];
        }
        return a.name.localeCompare(b.name);
      });

      return result;
    } catch (error) {
      logger.error(`[终端工具] 对象检查错误: ${error.stack || error.message}`);
      return {
        name,
        type: this.getType(obj),
        error: `检查错误: ${error.message}`,
        properties: [],
        methods: [],
      };
    }
  }

  getType(obj) {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';

    if (obj._events && obj._eventsCount && typeof obj.emit === 'function') return 'EventEmitter';
    if (obj.group && obj.user_id && obj.message) return 'MessageEvent';
    if (obj.user_id && obj.nickname && !obj.message) return 'User';
    if (obj.group_id && obj.group_name) return 'Group';
    if (obj.sendMsg && obj.pickUser && obj.pickGroup) return 'AgentRuntime';

    if (Array.isArray(obj)) return 'Array';
    if (obj instanceof Date) return 'Date';
    if (obj instanceof RegExp) return 'RegExp';
    if (Error.isError(obj)) return obj.constructor.name;
    if (obj instanceof Map) return 'Map';
    if (obj instanceof Set) return 'Set';
    if (obj instanceof WeakMap) return 'WeakMap';
    if (obj instanceof WeakSet) return 'WeakSet';
    if (obj instanceof Promise) return 'Promise';
    if (Buffer.isBuffer(obj)) return 'Buffer';
    if (obj instanceof stream.Readable) return 'ReadableStream';
    if (obj instanceof stream.Writable) return 'WritableStream';

    if (typeof obj === 'function') {
      return obj.constructor.name === 'Function' ? 'Function' : obj.constructor.name;
    }

    if (typeof obj === 'object') {
      if (!obj.constructor) return 'Object';
      return obj.constructor.name;
    }

    return typeof obj;
  }

  formatValue(value, depth = 0) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    if (typeof value === 'string') {
      if (value.length > this.options.maxStringLength) {
        return `"${value.substring(0, this.options.maxStringLength - 3)}..."`;
      }
      return `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (typeof value === 'function') {
      let funcStr = value.toString();
      if (funcStr.includes('[native code]')) {
        return value.name ? `function ${value.name}() [native]` : 'function() [native]';
      }
      if (funcStr.length > 200) funcStr = funcStr.substring(0, 197) + '...';
      return funcStr;
    }

    if (typeof value === 'object') {
      if (depth > 2) return `[${this.getType(value)}]`;
      
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const items = value.slice(0, this.options.maxArrayItems).map((item) => {
          return typeof item === 'object' && item !== null ? this.getType(item) : this.formatValue(item, depth + 1);
        });
        if (value.length > this.options.maxArrayItems) items.push(`...共${value.length}项`);
        return `[${items.join(', ')}]`;
      }

      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return value.toString();
      if (Error.isError(value)) return `${value.name}: ${value.message}`;
      
      if (value instanceof Map) {
        return `Map(${value.size})`;
      }
      if (value instanceof Set) {
        return `Set(${value.size})`;
      }
      if (Buffer.isBuffer(value)) {
        return `Buffer(${value.length})`;
      }

      return `[${this.getType(value)}]`;
    }

    return String(value);
  }

  collectPropertiesAndMethods(obj, result, seen, depth) {
    if (depth >= this.options.maxDepth) {
      result.properties.push({
        name: '(达到最大深度)',
        type: 'info',
        value: `最大深度: ${this.options.maxDepth}`,
        from: 'info',
      });
      return;
    }

    if (this.options.circularDetection && typeof obj === 'object' && obj !== null) {
      if (seen.has(obj)) {
        result.properties.push({
          name: '(循环引用)',
          type: 'circular',
          value: '(循环引用到上层对象)',
          from: 'circular',
        });
        return;
      }
      seen.set(obj, true);
    }

    try {
      if (Array.isArray(obj)) {
        result.properties.push({
          name: 'length',
          type: 'number',
          value: String(obj.length),
          from: 'own',
        });

        const maxItems = Math.min(obj.length, this.options.maxArrayItems);
        for (let i = 0; i < maxItems; i++) {
          try {
            const item = obj[i];
            const itemType = typeof item;
            result.properties.push({
              name: String(i),
              type: itemType === 'object' && item !== null ? this.getType(item) : itemType,
              value: this.formatValue(item),
              from: 'array',
              isArrayItem: true,
            });
          } catch (itemError) {
            result.properties.push({
              name: String(i),
              type: 'error',
              value: `[无法访问: ${itemError.message}]`,
              from: 'array',
              isArrayItem: true,
            });
          }
        }
        if (obj.length > maxItems) {
          result.properties.push({
            name: `...剩余${obj.length - maxItems}项`,
            type: 'info',
            value: '(已省略)',
            from: 'array',
            isArrayItem: true,
          });
        }
      }

      let ownProps = [];
      try {
        ownProps = Object.getOwnPropertyNames(obj);
      } catch (error) {
        result.properties.push({
          name: '(错误)',
          type: 'error',
          value: `获取属性名失败: ${error.message}`,
          from: 'error',
        });
      }

      if (ownProps.length > this.options.maxPropertiesPerObject) {
        ownProps = ownProps.slice(0, this.options.maxPropertiesPerObject);
        result.properties.push({
          name: '(已限制)',
          type: 'info',
          value: `属性数量超过限制，仅显示 ${this.options.maxPropertiesPerObject}/${Object.getOwnPropertyNames(obj).length} 项`,
          from: 'info',
        });
      }

      for (const prop of ownProps) {
        try {
          if (Array.isArray(obj) && ((!isNaN(parseInt(prop)) && parseInt(prop) < this.options.maxArrayItems) || prop === 'length')) continue;
          if (prop.startsWith('Symbol(') || prop === 'constructor' || prop === '_events' || prop === '_eventsCount') continue;

          const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
          
          if (descriptor && (descriptor.get || descriptor.set)) {
            if (this.options.showGettersSetters) {
              let accessorValue = '无法访问';
              if (descriptor.get) {
                try {
                  const value = obj[prop];
                  accessorValue = this.formatValue(value);
                } catch (getterError) {
                  accessorValue = `[访问器错误: ${getterError.message}]`;
                }
              }
              result.properties.push({
                name: prop,
                type: descriptor.get && descriptor.set ? 'accessor' : descriptor.get ? 'getter' : 'setter',
                value: accessorValue,
                from: 'own',
              });
            }
            continue;
          }

          let value;
          try {
            value = obj[prop];
          } catch (accessError) {
            result.properties.push({
              name: prop,
              type: 'error',
              value: `[无法访问: ${accessError.message}]`,
              from: 'own',
            });
            continue;
          }

          if (typeof value === 'function') {
            if (this.options.showFunctions) {
              result.methods.push({
                name: prop,
                params: this.extractFunctionParams(value),
                from: 'own',
                returnType: '未知',
              });
            }
          } else {
            result.properties.push({
              name: prop,
              type: typeof value,
              value: this.formatValue(value),
              from: 'own',
            });
          }
        } catch (propError) {
          result.properties.push({
            name: prop,
            type: 'error',
            value: `[无法访问: ${propError.message}]`,
            from: 'own',
          });
        }
      }

      if (this.options.showPrototype) {
        try {
          const proto = Object.getPrototypeOf(obj);
          if (proto && proto !== Object.prototype && proto !== Function.prototype) {
            let protoProps = [];
            try {
              protoProps = Object.getOwnPropertyNames(proto);
            } catch {
              // 静默处理
            }

            for (const prop of protoProps) {
              if (prop === 'constructor' || prop.startsWith('__')) continue;

              try {
                const value = proto[prop];
                if (typeof value === 'function') {
                  if (this.options.showFunctions && !result.methods.some((m) => m.name === prop)) {
                    result.methods.push({
                      name: prop,
                      params: this.extractFunctionParams(value),
                      from: 'proto',
                      returnType: '未知',
                    });
                  }
                }
              } catch {
                // 跳过原型属性错误
              }
            }
          }
        } catch {
          // 静默处理
        }
      }
    } catch (error) {
      logger.error(`[终端工具] 收集属性方法错误: ${error.message}`);
      result.properties.push({
        name: '(错误)',
        type: 'error',
        value: `收集属性失败: ${error.message}`,
        from: 'error',
      });
    }
  }

  extractFunctionParams(func) {
    try {
      const funcStr = func.toString();
      if (funcStr.includes('[native code]')) {
        return '';
      }

      const arrowMatch = funcStr.match(/^\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*=>\s*/);
      if (arrowMatch) return arrowMatch[1] || arrowMatch[2] || '';
      const paramsMatch = funcStr.match(/^\s*(?:async\s*)?function(?:\s+\w+)?\s*\(([^)]*)\)/);
      return paramsMatch ? paramsMatch[1] : '';
    } catch {
      return '(无法解析参数)';
    }
  }

  formatResult(result) {
    if (result.error) return `错误: ${result.error}`;

    let output = `【${result.name} 对象详情】\n`;
    output += `类型: ${result.type}\n`;
    if (result.value !== undefined) output += `值: ${result.value}\n`;
    output += `共 ${result.methodCount || 0} 个方法, ${result.propertyCount || 0} 个属性\n\n`;

    if (result.properties && result.properties.length > 0) {
      const ownProps = result.properties.filter(p => p.from === 'own' && !p.isArrayItem);
      const arrayProps = result.properties.filter(p => p.isArrayItem);
      const protoProps = result.properties.filter(p => p.from === 'proto');
      const otherProps = result.properties.filter(p => !['own', 'proto'].includes(p.from) && !p.isArrayItem);

      if (arrayProps.length > 0) {
        output += `—— 数组项 (${arrayProps.length}) ——\n`;
        for (const prop of arrayProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (ownProps.length > 0) {
        output += `—— 自有属性 (${ownProps.length}) ——\n`;
        for (const prop of ownProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (protoProps.length > 0) {
        output += `—— 继承属性 (${protoProps.length}) ——\n`;
        for (const prop of protoProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}]\n`;
        }
        output += '\n';
      }

      if (otherProps.length > 0) {
        output += `—— 其他属性 (${otherProps.length}) ——\n`;
        for (const prop of otherProps) {
          output += `• ${prop.name}: ${prop.value} [${prop.type}] (${prop.from})\n`;
        }
        output += '\n';
      }
    }

    if (result.methods && result.methods.length > 0) {
      const ownMethods = result.methods.filter(m => m.from === 'own');
      if (ownMethods.length > 0) {
        output += `—— 自有方法 (${ownMethods.length}) ——\n`;
        for (const method of ownMethods) {
          const params = method.params ? `(${method.params})` : '()';
          output += `• ${method.name}${params}\n`;
        }
        output += '\n';
      }

      const protoMethods = result.methods.filter(m => m.from === 'proto');
      if (protoMethods.length > 0) {
        output += `—— 继承方法 (${protoMethods.length}) ——\n`;
        for (const method of protoMethods) {
          const params = method.params ? `(${method.params})` : '()';
          output += `• ${method.name}${params}\n`;
        }
      }
    }

    return output;
  }
}

/**
 * 增强的JavaScript执行器
 */
class JavaScriptExecutor {
  /**
   * 格式化执行结果为字符串
   */
  formatResult(result, depth = 0, seen = new WeakSet()) {
    if (result === undefined) return 'undefined';
    if (result === null) return 'null';
    
    // 基本类型直接转字符串
    if (typeof result === 'string') return result;
    if (typeof result === 'number') return String(result);
    if (typeof result === 'boolean') return String(result);
    if (typeof result === 'symbol') return result.toString();
    if (typeof result === 'bigint') return result.toString() + 'n';
    
    // 函数
    if (typeof result === 'function') {
      const funcStr = result.toString();
      if (funcStr.length > 200) {
        return funcStr.substring(0, 197) + '...';
      }
      return funcStr;
    }
    
    // 对象类型
    if (typeof result === 'object') {
      // 防止循环引用
      if (seen.has(result)) {
        return '[Circular Reference]';
      }
      seen.add(result);

      // 特殊对象处理
      if (result instanceof Promise) {
        return '[Promise]';
      }
      if (Error.isError(result)) {
        return `${result.name}: ${result.message}\n${result.stack}`;
      }
      if (result instanceof Date) {
        return result.toISOString();
      }
      if (result instanceof RegExp) {
        return result.toString();
      }
      if (Buffer.isBuffer(result)) {
        return `Buffer(${result.length}): ${result.toHex().substring(0, 100)}...`;
      }
      if (result instanceof Map) {
        const entries = Array.from(result.entries()).slice(0, 10);
        return `Map(${result.size}) { ${entries.map(([k, v]) => 
          `${this.formatResult(k, depth + 1, seen)} => ${this.formatResult(v, depth + 1, seen)}`
        ).join(', ')}${result.size > 10 ? ', ...' : ''} }`;
      }
      if (result instanceof Set) {
        const values = Array.from(result).slice(0, 10);
        return `Set(${result.size}) { ${values.map(v => 
          this.formatResult(v, depth + 1, seen)
        ).join(', ')}${result.size > 10 ? ', ...' : ''} }`;
      }

      try {
        // 尝试使用 JSON.stringify
        const maxOutputLength = config.get('maxOutputLength', 5000)
        const jsonStr = JSON.stringify(result, (key, value) => {
          if (typeof value === 'bigint') return value.toString() + 'n';
          if (typeof value === 'function') return '[Function]';
          if (typeof value === 'symbol') return value.toString();
          return value;
        }, 2);
        
        if (jsonStr.length > maxOutputLength) {
          return jsonStr.substring(0, maxOutputLength - 3) + '...';
        }
        return jsonStr;
    } catch {
        // 无法JSON化的对象，使用 util.inspect
        try {
          const maxOutputLength = config.get('maxOutputLength', 5000)
          const inspectStr = util.inspect(result, { 
            depth: 3, 
            colors: false, 
            maxArrayLength: 100,
            breakLength: 80,
            compact: false,
            getters: true,
            showHidden: false,
            customInspect: true
          });
          if (inspectStr.length > maxOutputLength) {
            return inspectStr.substring(0, maxOutputLength - 3) + '...';
          }
          return inspectStr;
        } catch {
          // 最后的备选方案
          return `[${result.constructor?.name || 'Object'}]`;
        }
      }
    }
    
    return String(result);
  }

  /**
   * 检测代码类型和特性
   */
  analyzeCode(code) {
    const features = {
      isExpression: false,
      isAsync: false,
      hasAwait: false,
      hasReturn: false,
      hasImport: false,
      hasExport: false,
      hasClass: false,
      hasFunction: false,
      isMultiline: false,
      isStatement: false
    };

    features.isMultiline = code.includes('\n') || code.includes(';');
    features.hasAwait = /\bawait\s+/.test(code);
    features.hasReturn = /\breturn\s+/.test(code);
    features.hasImport = /\bimport\s+/.test(code);
    features.hasExport = /\bexport\s+/.test(code);
    features.hasClass = /\bclass\s+\w+/.test(code);
    features.hasFunction = /\b(function|async\s+function|const\s+\w+\s*=\s*async|\w+\s*:\s*async)/.test(code);
    features.isAsync = features.hasAwait || /\basync\s+/.test(code);

    // 判断是否为表达式（含 await 的异步表达式须用 AsyncFunction 检测）
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    try {
      new Function(`return (${code})`);
      features.isExpression = true;
    } catch {
      try {
        new AsyncFunction(`return (${code});`);
        features.isExpression = true;
      } catch {
        features.isExpression = false;
        features.isStatement = true;
      }
    }

    return features;
  }

  /**
   * 执行JavaScript代码 - 安全模式
   */
  async executeSafe(code, globalContext) {
    const features = this.analyzeCode(code);
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    const contextKeys = Object.keys(globalContext);
    const contextValues = contextKeys.map((key) => globalContext[key]);
    
    let result;
    
    // 根据代码特性选择执行策略
    if (features.hasImport || features.hasExport) {
      throw new Error('Safe mode does not support import/export statements. Use enhanced mode instead.');
    }

    // 优先尝试表达式模式
    if (features.isExpression && !features.isMultiline) {
      try {
        const exprFunction = features.isAsync || features.hasAwait
          ? new AsyncFunction(...contextKeys, `return (${code});`)
          : new Function(...contextKeys, `return (${code});`);
        result = await exprFunction(...contextValues);
        return result;
      } catch (error) {
        if (!error.message.includes('Unexpected token')) {
          throw error;
        }
      }
    }

    // 语句模式执行
    try {
      let wrappedCode = code;
      
      // 顶层 await：必须 return，否则单行表达式会得到 undefined
      if (features.hasAwait && !features.hasFunction) {
        wrappedCode = features.hasReturn || features.isMultiline
          ? `return (async () => { ${code} })();`
          : `return (${code});`;
      }
      
      const stmtFunction = new AsyncFunction(...contextKeys, wrappedCode);
      result = await stmtFunction(...contextValues);
    } catch (error) {
      // 如果是返回值问题，尝试包装执行
      if (error.message.includes('return') || error.message.includes('await')) {
        try {
          const wrappedFunction = new AsyncFunction(...contextKeys, 
            `return (async function() {
              ${code}
            })();`
          );
          result = await wrappedFunction(...contextValues);
        } catch (wrapError) {
          throw wrapError;
        }
      } else {
        throw error;
      }
    }
    
    return result;
  }

  /**
   * 执行JavaScript代码 - 增强模式
   */
  async executeEnhanced(code, globalContext) {
    // 创建一个更宽松的执行环境
    const script = new vm.Script(`
      (async function() {
        ${code}
      })()
    `);
    
    const sandbox = {
      ...globalContext,
      console,
      require,
      process,
      global,
      Buffer,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      Promise,
      EventEmitter: require('events').EventEmitter,
      __dirname: ROOT_PATH,
      __filename: configFile
    };
    
    const context = vm.createContext(sandbox);
    
    try {
      const result = await script.runInContext(context, {
        timeout: config.get('jsTimeout', 10000),
        displayErrors: true
      });
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 执行JavaScript代码 - 沙箱模式
   */
  async executeSandbox(code, globalContext) {
    // 创建受限的沙箱环境
    const limitedContext = {
      console: {
        log: (...args) => args.join(' '),
        error: (...args) => args.join(' '),
        warn: (...args) => args.join(' '),
        info: (...args) => args.join(' ')
      },
      Math,
      Date,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      // 只提供必要的全局对象
      e: globalContext.e,
      AgentRuntime: globalContext.AgentRuntime,
      segment: globalContext.segment
    };
    
    const script = new vm.Script(code);
    const context = vm.createContext(limitedContext);
    
    try {
      const result = script.runInContext(context, {
        timeout: 5000,
        displayErrors: true
      });
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 执行JavaScript代码
   */
  async execute(code, globalContext, mode = null) {
    const startTime = Date.now();
    const execMode = mode || config.get('jsExecutionMode', 'safe');
    
    try {
      let result;
      
      switch (execMode) {
        case 'enhanced':
          result = await this.executeEnhanced(code, globalContext);
          break;
        case 'sandbox':
          result = await this.executeSandbox(code, globalContext);
          break;
        case 'safe':
        default:
          result = await this.executeSafe(code, globalContext);
          break;
      }
      
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      return {
        success: true,
        result: result,
        executionTime: executionTime,
        resultType: typeof result === 'object' && result !== null ? 
          result.constructor?.name || 'Object' : 
          typeof result,
        mode: execMode
      };
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      
      return {
        success: false,
        error: error.message,
        stack: error.stack,
        executionTime: executionTime,
        mode: execMode
      };
    }
  }

  /**
   * 评估表达式（快速计算）
   */
  async evaluate(expression, globalContext = {}) {
    const keys = Object.keys(globalContext);
    const values = keys.map((key) => globalContext[key]);
    const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
    try {
      const useAsync = /\bawait\s+/.test(expression);
      const func = useAsync
        ? new AsyncFunction(...keys, `return (${expression});`)
        : new Function(...keys, `return (${expression});`);
      const result = useAsync ? await func(...values) : func(...values);
      return {
        success: true,
        result,
        type: typeof result,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * 异步执行代码片段
   */
  async executeAsync(code, globalContext) {
    return this.execute(code, globalContext, 'enhanced');
  }
}

// 初始化组件：config/terminal/history/inspector 在模块加载时构建一次即可（常量单例）
const configFile = path.join(ROOT_PATH, 'config', 'cmd', 'tools.yaml');
const config = new ToolsConfig(configFile);
const terminal = new TerminalHandler();
const history = new CommandHistory(config.get('maxHistory', 100));
const inspector = new ObjectInspector({
  maxDepth: config.get('maxObjectDepth', 4),
  circularDetection: config.get('circularDetection', true),
  showPrototype: true,
  showGettersSetters: true,
  showFunctions: true,
  maxArrayItems: 30,
  maxStringLength: 200
});
const jsExecutor = new JavaScriptExecutor();

/** rj / roj / roi 共享的 JS 沙箱静态绑定（不含 e、plugin、运行时全局） */
const JS_SANDBOX_STATIC = {
  AgentRuntime,
  common,
  runtimeConfig,
  process,
  os,
  fs,
  path,
  moment,
  util,
  terminal,
  config,
  history,
  inspector,
  jsExecutor,
  YAML,
  fetch: globalThis.fetch,
  crypto,
  zlib,
  querystring,
  url,
  stream,
  vm,
  Buffer,
  EventEmitter,
  console,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  Promise,
  ROOT_PATH,
}

/**
 * 增强型终端工具插件
 */
export class EnhancedTools extends PluginBase {
  constructor() {
    const permission = config.get('permission', 'master');
    super({
      name: '终端工具',
      dsc: '执行终端命令和JavaScript代码',
      event: 'message',
      priority: 600,
      rule: [
        {
          reg: /^rx\s*([\s\S]*?)$/i,
          fnc: 'runTerminalXRK',
          permission,
        },
        {
          reg: /^rh\s*([\s\S]*?)$/i,
          fnc: 'runTerminalhome',
          permission,
        },
        {
          reg: /^roj\s*([\s\S]*?)$/i,
          fnc: 'runJavaScript',
          permission,
        },
        {
          reg: /^roi\s*([\s\S]*?)$/i,
          fnc: 'inspectObject',
          permission,
        },
        {
          reg: /^rj\s*([\s\S]*?)$/i,
          fnc: 'quickEvaluate',
          permission,
        },
        {
          reg: /^rrl\s*(\w*)\s*(\d*)\s*$/i,
          fnc: 'showHistory',
          permission,
        },
        {
          reg: /^rc\s*([\s\S]*?)$/i,
          fnc: 'configTool',
          permission,
        },
      ],
    });
  }

  /** 检查命令是否在黑名单中 */
  async checkBlacklist(e, cmd) {
    if (!config.get('blacklist', true)) return false;
    const banList = config.get('ban', []);
    for (const bannedCmd of banList) {
      if (cmd.includes(bannedCmd)) {
        await e.reply(`❌ 命令 "${cmd}" 包含禁用关键词 "${bannedCmd}"`, true);
        logger.debug(`已拦截黑名单命令: ${cmd}`);
        return true;
      }
    }
    return false;
  }

  /** 执行终端命令（项目目录） */
  async runTerminalXRK(e) {
    const msg = e.msg.replace(/^rx\s*/i, '').trim();
    if (!msg) return false;

    if (await this.checkBlacklist(e, msg)) return true;

    try {
      const options = {
        cwd: ROOT_PATH,
        shell: config.get('shell', true),
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '1' },
      };

      const timeout = config.get('timeout', 300000);
      const result = await terminal.execute(e, msg, options, timeout);

      history.add(msg, 'terminal', result.code);

      if (result.message) {
        const icon = result.code === 0 ? '✅' : '❌';
        await 制作聊天记录(e, result.message, `${icon} Terminal`, `命令: ${msg} | 返回代码: ${result.code} | 用时: ${this.getExecutionTime(result)}秒`);
      } else {
        await e.reply('✅ 命令执行完成，无输出', true);
      }
    } catch (error) {
      logger.error(`[终端工具] 命令执行错误: ${error.stack || error.message}`);
      await e.reply(`❌ 执行错误: ${error.message}`);
    }

    return true;
  }

  /** 执行终端命令（用户主目录） */
  async runTerminalhome(e) {
    const msg = e.msg.replace(/^rh\s*/i, '').trim();
    if (!msg) return false;

    if (await this.checkBlacklist(e, msg)) return true;

    try {
      const homePath = process.env.HOME || os.homedir();
      const options = {
        cwd: homePath,
        shell: config.get('shell', true),
        stdio: 'pipe',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '1' },
      };

      const timeout = config.get('timeout', 300000);
      const result = await terminal.execute(e, msg, options, timeout);

      history.add(msg, 'terminal', result.code);

      if (result.message) {
        const icon = result.code === 0 ? '✅' : '❌';
        await 制作聊天记录(e, result.message, `${icon} Terminal (HOME)`, `目录: ${homePath} | 命令: ${msg} | 返回代码: ${result.code}`);
      } else {
        await e.reply('✅ 命令执行完成，无输出', true);
      }
    } catch (error) {
      logger.error(`[终端工具] 命令执行错误: ${error.stack || error.message}`);
      await e.reply(`❌ 执行错误: ${error.message}`);
    }

    return true;
  }

  /** 
   * roj - 完整JavaScript执行（支持多行代码、异步、类定义等）
   * 特点：支持复杂代码结构，完整错误栈追踪，可选执行模式
   */
  async runJavaScript(e) {
    const code = e.msg.replace(/^roj\s*/i, '').trim();
    if (!code) {
      await e.reply(`📝 roj - 完整JavaScript执行器
支持：多行代码、async/await、类定义、复杂逻辑
用法：roj <JavaScript代码>
示例：
roj const arr = [1,2,3]; 
    const sum = arr.reduce((a,b) => a+b, 0);
    console.log(sum);
    return sum;`, true);
      return true;
    }

    const globalContext = this.getGlobalContext(e);

    try {
      const result = await jsExecutor.execute(code, globalContext);
      
      history.add(code, 'javascript', result.success ? 0 : 1);

      if (result.success) {
        const output = jsExecutor.formatResult(result.result);
        const maxOutputLength = config.get('maxOutputLength', 5000);
        
        let finalOutput = output;
        if (output.length > maxOutputLength) {
          const outputFile = terminal.saveOutputToFile(code, output);
          if (outputFile) {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出太长 (${output.length} 字符)，完整输出已保存到: ${outputFile}`;
          } else {
            finalOutput = output.substring(0, maxOutputLength) + 
              `\n\n... 输出被截断 (共 ${output.length} 字符)`;
          }
        }
        
        await 制作聊天记录(
          e, 
          finalOutput, 
          '✅ JavaScript 执行结果', 
          `类型: ${result.resultType} | 模式: ${result.mode} | 用时: ${result.executionTime}秒`
        );
      } else {
        let errorMsg = `❌ 执行错误\n错误信息: ${result.error}`;
        if (config.get('jsExecutionMode') === 'safe' && result.error.includes('import')) {
          errorMsg += '\n\n💡 提示：Safe模式不支持import/export，可使用 rc set jsExecutionMode enhanced 切换到增强模式';
        }
        await 制作聊天记录(
          e,
          errorMsg + (result.stack ? `\n\n调用栈:\n${result.stack}` : ''),
          '❌ JavaScript执行错误',
          `模式: ${result.mode} | 用时: ${result.executionTime}秒`
        );
      }
    } catch (error) {
      await e.reply(`❌ 执行错误: ${error.message}`, true);
      logger.error(`[终端工具] JavaScript执行错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 
   * roi - 对象深度检查（详细分析对象结构）
   * 特点：显示对象所有属性、方法、原型链，支持循环引用检测
   */
  async inspectObject(e) {
    const code = e.msg.replace(/^roi\s*/i, '').trim();
    if (!code) {
      await e.reply(`🔍 roi - 对象深度检查器
功能：详细分析对象结构、属性、方法、原型链
用法：roi <对象或表达式>
示例：
roi e                    // 检查事件对象
roi AgentRuntime                  // 检查AgentRuntime对象
roi process.versions     // 检查版本信息
roi new Date()          // 检查日期对象`, true);
      return true;
    }

    const globalContext = this.getGlobalContext(e);

    try {
      const execResult = await jsExecutor.execute(code, globalContext);
      
      if (execResult.success) {
        const result = inspector.inspect(execResult.result, code);
        const output = inspector.formatResult(result);
        
        // 发送对象检查结果
        if (output && output.trim()) {
          await 制作聊天记录(
            e, 
            output, 
            `🔍 对象检查结果`, 
            `表达式: ${code} | 类型: ${result.type} | 属性: ${result.propertyCount || 0} | 方法: ${result.methodCount || 0}`
          );
        }
        
        // 如果对象很大，提供额外的统计信息
        if (result.propertyCount > 50 || result.methodCount > 20) {
          const stats = `📊 统计信息:
• 总属性数: ${result.propertyCount}
• 总方法数: ${result.methodCount}
• 检查深度: ${config.get('maxObjectDepth', 4)}
• 显示模式: ${config.get('printMode', 'full')}`;
          await e.reply(stats, true);
        }
      } else {
        await e.reply(`❌ 执行错误: ${execResult.error}`, true);
      }
    } catch (error) {
      await e.reply(`❌ 检查对象错误: ${error.message}`, true);
      logger.error(`[终端工具] 对象检查错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 
   * rj - 快速表达式计算（简单计算和方法调用）
   * 特点：快速执行单行表达式，自动返回结果，适合快速测试
   */
  async quickEvaluate(e) {
    const expression = e.msg.replace(/^rj\s*/i, '').trim();
    if (!expression) {
      await e.reply(`⚡ rj - 快速表达式计算器
功能：快速执行单行表达式和简单计算
用法：rj <表达式>
示例：
rj 1 + 2 * 3                   // 数学计算
rj Math.random()                // 调用方法
rj AgentRuntime.uin                      // 获取属性
rj [1,2,3].map(x => x*2)       // 数组操作
rj e.reply("Hello!")           // 发送消息`, true);
      return true;
    }

    const globalContext = this.getGlobalContext(e);

    try {
      // 对于简单表达式，使用快速计算模式
      const isSimpleExpression = !expression.includes('\n') && 
                                 !expression.includes(';') &&
                                 !expression.includes('await') &&
                                 !expression.includes('async');
      
      let result;
      if (isSimpleExpression) {
        // 使用快速计算
        result = await jsExecutor.evaluate(expression, globalContext);
        if (!result.success) {
          // 如果快速计算失败，回退到完整执行
          result = await jsExecutor.execute(expression, globalContext, 'safe');
        } else {
          result.executionTime = '< 0.01';
          result.resultType = result.type;
          result.mode = 'eval';
        }
      } else {
        // 复杂表达式使用完整执行
        result = await jsExecutor.execute(expression, globalContext, 'safe');
      }

      if (result.success && result.result != null && typeof result.result.then === 'function') {
        try {
          result.result = await result.result;
          if (result.resultType === 'object' && result.result && typeof result.result === 'object') {
            result.resultType = result.result.constructor?.name || 'object';
          }
        } catch (promiseErr) {
          result.success = false;
          result.error = promiseErr?.message || String(promiseErr);
        }
      }

      history.add(expression, 'javascript', result.success ? 0 : 1);

      if (result.success) {
        const output = jsExecutor.formatResult(result.result);
        
        // 对于简单结果，直接回复
        if (output.length < 500 && !output.includes('\n')) {
          await e.reply(`✅ 结果: ${output}`, true);
        } else {
          const maxOutputLength = config.get('maxOutputLength', 5000);
          let finalOutput = output;
          
          if (output.length > maxOutputLength) {
            const outputFile = terminal.saveOutputToFile(expression, output);
            if (outputFile) {
              finalOutput = output.substring(0, maxOutputLength) + 
                `\n\n... 输出太长 (${output.length} 字符)，完整输出已保存到: ${outputFile}`;
            } else {
              finalOutput = output.substring(0, maxOutputLength) + 
                `\n\n... 输出被截断 (共 ${output.length} 字符)`;
            }
          }
          
          await 制作聊天记录(
            e, 
            finalOutput, 
            '⚡ 快速计算结果', 
            `表达式: ${expression.substring(0, 50)}${expression.length > 50 ? '...' : ''} | 类型: ${result.resultType}`
          );
        }
      } else {
        await e.reply(`❌ 计算错误: ${result.error}`, true);
      }
    } catch (error) {
      await e.reply(`❌ 执行错误: ${error.message}`, true);
      logger.error(`[终端工具] 快速计算错误: ${error.stack || error.message}`);
    }

    return true;
  }

  /** 显示历史记录 */
  async showHistory(e) {
    const match = /^rrl\s*(\w*)\s*(\d*)\s*$/i.exec(e.msg);
    const type = match[1]?.toLowerCase() || '';
    const limit = match[2] ? parseInt(match[2]) : 10;

    if (type === 'clear' || type === 'c') {
      const result = history.clear();
      if (result) {
        await e.reply('✅ 命令历史记录已清空', true);
      } else {
        await e.reply('❌ 清空历史记录失败', true);
      }
      return true;
    }

    let historyType = null;
    let title = '命令历史记录';
    let icon = '📜';

    if (type === 't' || type === 'terminal') {
      historyType = 'terminal';
      title = '终端命令历史';
      icon = '🖥️';
    } else if (type === 'j' || type === 'js' || type === 'javascript') {
      historyType = 'javascript';
      title = 'JavaScript代码历史';
      icon = '📝';
    }

    const historyItems = history.get(limit, historyType);
    if (historyItems.length === 0) {
      await e.reply(`${icon} 暂无${title}`, true);
      return true;
    }

    let historyText = '';
    for (let i = 0; i < historyItems.length; i++) {
      const item = historyItems[i];
      const time = moment(item.timestamp).format('MM-DD HH:mm');
      const status = item.code === 0 ? '✅' : '❌';
      const typeIcon = item.type === 'terminal' ? '🖥️' : '📝';
      let command = item.command;
      if (command.length > 50) {
        command = command.substring(0, 47) + '...';
      }
      historyText += `${i + 1}. ${status} ${typeIcon} [${time}]\n   ${command}\n\n`;
    }

    await 制作聊天记录(e, historyText.trim(), `${icon} ${title}`, `共 ${historyItems.length} 条记录`);
    return true;
  }

  /** 配置工具 */
  async configTool(e) {
    const cmd = e.msg.replace(/^rc\s*/i, '').trim().toLowerCase();

    if (!cmd || cmd === 'show' || cmd === 'list') {
      const configData = config.config;
      let configText = '【工具配置】\n\n';
      
      const configDesc = {
        permission: '权限等级',
        blacklist: '启用黑名单',
        ban: '禁用命令列表',
        shell: '使用系统Shell',
        timeout: '命令超时时间(ms)',
        maxHistory: '最大历史记录数',
        updateInterval: '更新间隔(ms)',
        maxOutputLength: '最大输出长度',
        maxObjectDepth: '对象检查深度',
        circularDetection: '循环引用检测',
        printMode: '输出模式',
        saveChunkedOutput: '保存分块输出',
        jsExecutionMode: 'JS执行模式',
        jsTimeout: 'JS超时时间(ms)'
      };

      for (const [key, value] of Object.entries(configData)) {
        const desc = configDesc[key] || key;
        let displayValue = value;
        if (typeof value === 'object') {
          displayValue = JSON.stringify(value);
        }
        configText += `• ${desc} (${key}): ${displayValue}\n`;
      }
      
      configText += '\n💡 提示: 使用 rc set <key> <value> 修改配置';

      await 制作聊天记录(e, configText, '⚙️ 工具配置', '当前配置项');
      return true;
    }

    const setMatch = /^set\s+(\w+)\s+(.+)$/i.exec(cmd);
    if (setMatch) {
      const key = setMatch[1];
      let value = setMatch[2];

      try {
        if (value.toLowerCase() === 'true') {
          value = true;
        } else if (value.toLowerCase() === 'false') {
          value = false;
        } else if (!isNaN(value)) {
          value = Number(value);
        } else if (value.startsWith('[') && value.endsWith(']')) {
          value = JSON.parse(value);
        } else if (value.startsWith('{') && value.endsWith('}')) {
          value = JSON.parse(value);
        }
      } catch {
        // 保持原值
      }

      // 特殊配置项验证
      if (key === 'jsExecutionMode' && !['safe', 'enhanced', 'sandbox'].includes(value)) {
        await e.reply(`❌ jsExecutionMode 只能是: safe, enhanced, sandbox`, true);
        return true;
      }

      config.set(key, value);
      await e.reply(`✅ 配置已更新: ${key} = ${value}`, true);
      
      return true;
    }

    if (cmd === 'reset') {
      try {
        if (fs.existsSync(config.configPath)) {
          fs.unlinkSync(config.configPath);
        }
        config.config = {};
        config.loadConfig();
        await e.reply('✅ 配置已重置为默认值', true);
      } catch (error) {
        await e.reply(`❌ 重置配置失败: ${error.message}`, true);
      }
      return true;
    }

    if (cmd === 'help') {
      const helpText = `📋 配置命令帮助

基础命令:
• rc - 显示当前配置
• rc set <key> <value> - 设置配置项
• rc reset - 重置为默认配置
• rc help - 显示此帮助信息

JS执行模式:
• safe - 安全模式(默认)，限制某些功能
• enhanced - 增强模式，支持更多特性
• sandbox - 沙箱模式，隔离执行环境

示例:
• rc set jsExecutionMode enhanced
• rc set timeout 60000
• rc set maxOutputLength 10000`;

      await 制作聊天记录(e, helpText, '📋 配置帮助', '工具配置说明');
      return true;
    }

    await e.reply(`📋 配置命令帮助:
rc - 显示当前配置
rc set <key> <value> - 设置配置项
rc reset - 重置为默认配置
rc help - 显示详细帮助`, true);
    return true;
  }

  /** 获取执行时间 */
  getExecutionTime(result) {
    if (result.startTime && result.endTime) {
      return ((result.endTime - result.startTime) / 1000).toFixed(2);
    }
    return '未知';
  }

  /** 获取 rj/roj/roi 的全局上下文（每次浅拷贝，避免调用方污染静态绑定） */
  getGlobalContext(e = null) {
    return {
      ...JS_SANDBOX_STATIC,
      segment,
      logger,
      e,
      plugin: this,
    }
  }
}