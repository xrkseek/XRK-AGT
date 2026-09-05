// @ts-nocheck
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import RuntimeUtil from '#utils/runtime-util.js';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';

/**
 * 知识库工作流插件（数据库）
 * 
 * 所有功能都通过 MCP 工具提供：
 * - query_knowledge（查询知识）
 * - list_knowledge（列出知识库）
 * - save_knowledge（保存知识）
 * - delete_knowledge（删除知识）
 */
export default class DatabaseStream extends AiWorkflow {
  dbDir = path.join(os.homedir(), '.xrk', 'knowledge');
  databases = new Map();

  constructor() {
    super({
      name: 'database',
      description: '知识库工作流插件',
      version: '2.0.0',
      author: 'XRK',
      priority: 1,
      config: {
        enabled: true,
        temperature: 0.7,
        maxTokens: 2000
      },
      embedding: { enabled: true }
    });
  }

  async init() {
    await super.init();
    
    // 确保知识库目录存在
    await fs.mkdir(this.dbDir, { recursive: true });

    // 注册知识库相关功能（简化调用方式）
    this.registerAllFunctions();

  }

  /**
   * 注册所有知识库相关功能
   */
  registerAllFunctions() {
    /**
     * 保存知识到知识库
     * 
     * @description 将知识保存到指定的知识库中。支持文本或JSON格式的内容。
     * 
     * @param {string} db - 知识库名称（必填）
     * @param {string} content - 知识内容，支持文本或JSON格式（必填）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {string} returns.data.db - 知识库名称
     * @returns {string} returns.data.message - 操作结果消息
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * // 保存文本知识
     * { db: "faq", content: "如何重置密码？点击登录页面的'忘记密码'链接" }
     * 
     * // 保存JSON知识
     * { db: "products", content: '{"name": "产品A", "price": 100}' }
     */
    this.registerMCPTool('save_knowledge', {
      description: '保存知识到知识库。支持文本或 JSON 格式，可用于 RAG 关键词检索。',
      inputSchema: {
        type: 'object',
        properties: {
          db: {
            type: 'string',
            description: '知识库名称（如果不存在会自动创建）'
          },
          content: {
            type: 'string',
            description: '知识内容。可以是纯文本（如："如何重置密码？点击登录页面的忘记密码链接"）或JSON格式（如：\'{"name": "产品A", "price": 100, "description": "..."}\'）。系统会自动识别格式并处理。'
          }
        },
        required: ['db', 'content']
      },
      handler: async (args = {}, _context = {}) => {
        const { db, content } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };
        if (!content) return { success: false, error: '知识内容不能为空' };

        await this.saveKnowledge(db, content);
        RuntimeUtil.makeLog('info', `[${this.name}] 保存知识到知识库: ${db}`, 'DatabaseStream');
        
        return {
          success: true,
          data: { db, message: '知识保存成功' }
        };
      },
      enabled: true
    });

    /**
     * 查询知识库
     * 
     * @description 从指定知识库中查询知识（关键词匹配）。未指定关键词时返回全部。
     * 
     * @param {string} db - 知识库名称（必填）
     * @param {string} [keyword] - 搜索关键词（可选，不指定则返回所有知识）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {string} returns.data.db - 知识库名称
     * @returns {string} returns.data.keyword - 搜索的关键词（如果指定）
     * @returns {Array} returns.data.results - 查询结果列表
     * @returns {number} returns.data.count - 结果数量
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * // 关键词搜索
     * { db: "faq", keyword: "密码" }
     * 
     * // 获取所有知识
     * { db: "faq" }
     */
    this.registerMCPTool('query_knowledge', {
      description: '从知识库按关键词检索（子串匹配，非向量语义）。未指定 keyword 则返回该库全部条目。',
      inputSchema: {
        type: 'object',
        properties: {
          db: {
            type: 'string',
            description: '知识库名称'
          },
          keyword: {
            type: 'string',
            description: '关键词（可选；省略则列出该库全部）'
          }
        },
        required: ['db']
      },
      handler: async (args = {}, context = {}) => {
        const { db, keyword } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };

        const results = await this.queryKnowledge(db, keyword);
        RuntimeUtil.makeLog('info', `[${this.name}] 查询知识库: ${db}，找到 ${results.length} 条`, 'DatabaseStream');

        return {
          success: true,
          data: {
            db,
            keyword: keyword || '*',
            results,
            count: results.length
          }
        };
      },
      enabled: true
    });

    /**
     * 列出所有知识库
     * 
     * @description 列出系统中所有可用的知识库名称。
     * 
     * @param {} 无需参数
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {Array} returns.data.databases - 知识库名称列表
     * @returns {number} returns.data.count - 知识库数量
     * 
     * @example
     * // 调用示例
     * {}
     * 
     * // 返回示例
     * {
     *   success: true,
     *   data: {
     *     databases: ["faq", "products", "docs"],
     *     count: 3
     *   }
     * }
     */
    this.registerMCPTool('list_knowledge', {
      description: '列出所有可用的知识库。当需要查看系统中有哪些知识库、了解可用的知识库名称时使用此工具。返回所有已创建的知识库名称列表。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        const dbs = await this.listDatabases();
        return {
          success: true,
          data: {
            databases: dbs,
            count: dbs.length
          }
        };
      },
      enabled: true
    });

    /**
     * 删除知识
     * 
     * @description 从知识库中删除知识。支持按ID删除、按条件删除或删除所有知识。
     * 
     * @param {string} db - 知识库名称（必填）
     * @param {string} [condition] - 删除条件：知识ID（数字）、条件（key=value格式）或"*"（删除所有）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {string} returns.data.db - 知识库名称
     * @returns {string} returns.data.condition - 使用的删除条件
     * @returns {number} returns.data.deletedCount - 删除的知识数量
     * @returns {string} returns.data.message - 操作结果消息
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * // 按ID删除
     * { db: "faq", condition: "1234567890" }
     * 
     * // 按条件删除
     * { db: "products", condition: "category=old" }
     * 
     * // 删除所有
     * { db: "faq", condition: "*" }
     */
    this.registerMCPTool('delete_knowledge', {
      description:
        '删除知识库条目。须指定 condition：知识 ID、或 key=value；清空整库须 condition="*" 且 confirm=true。',
      inputSchema: {
        type: 'object',
        properties: {
          db: { type: 'string', description: '知识库名称' },
          condition: {
            type: 'string',
            description: '知识 ID / key=value / "*"（清空）'
          },
          confirm: {
            type: 'boolean',
            description: 'condition 为 * 时必须为 true',
            default: false
          }
        },
        required: ['db', 'condition']
      },
      handler: async (args = {}, _context = {}) => {
        const { db, condition, confirm } = args;
        if (!db) return { success: false, error: '知识库名称不能为空' };
        const cond = String(condition ?? '').trim();
        if (!cond) return { success: false, error: 'condition 必填（勿默认清空）' };
        if (cond === '*' && confirm !== true) {
          return { success: false, error: '清空知识库须 condition="*" 且 confirm=true' };
        }

        const count = await this.deleteKnowledge(db, cond);

        return {
          success: true,
          data: {
            db,
            condition: cond,
            deletedCount: count,
            message: `已删除 ${count} 条知识`
          }
        };
      },
      enabled: true
    });
  }

  /**
   * 保存知识（自动处理文本或 JSON）
   */
  async saveKnowledge(db, content) {
    const dbFile = path.join(this.dbDir, `${db}.json`);
    
    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      // 文件不存在，创建新数组
    }
    
    // 自动判断是文本还是JSON
    let knowledgeData;
    try {
      knowledgeData = JSON.parse(content);
    } catch {
      // 不是JSON，作为文本处理
      knowledgeData = { content, type: 'text' };
    }
    
    const record = {
      id: Date.now(),
      ...knowledgeData,
      createdAt: new Date().toISOString()
    };

    records.push(record);
    await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
    this.databases.set(db, records);
    
    RuntimeUtil.makeLog('info', `[${this.name}] 保存知识到知识库: ${db}`, 'DatabaseStream');
  }

  /**
   * 查询知识（关键词匹配）
   */
  async queryKnowledge(db, keyword) {
    const dbFile = path.join(this.dbDir, `${db}.json`);

    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      return [];
    }

    if (!keyword || keyword === '*') {
      return records;
    }

    const q = keyword.toLowerCase();
    return records.filter(record => JSON.stringify(record).toLowerCase().includes(q));
  }

  /**
   * 自动检索相关知识库内容（用于 RAG）
   */
  async retrieveKnowledgeContexts(query, maxResults = 5) {
    if (!query || !this.embeddingConfig.enabled) {
      return [];
    }

    try {
      const databases = await this.listDatabases({});
      if (databases.length === 0) return [];

      const allResults = [];
      
      // 从所有知识库检索
      for (const db of databases) {
        const results = await this.queryKnowledge(db, query, {});
        results.forEach(record => {
          const content = typeof record.content === 'string' 
            ? record.content 
            : JSON.stringify(record);
          allResults.push({
            source: `知识库:${db}`,
            content: content.substring(0, 200), // 限制长度
            record: record
          });
        });
      }

      return allResults.slice(0, maxResults);
    } catch (error) {
      RuntimeUtil.makeLog('debug', `[${this.name}] 检索知识库失败: ${error.message}`, 'DatabaseStream');
      return [];
    }
  }

  /**
   * 列出所有知识库
   */
  async listDatabases() {
    try {
      const files = await fs.readdir(this.dbDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
    } catch {
      return [];
    }
  }

  /**
   * 删除知识（简化版：支持ID或条件）
   */
  async deleteKnowledge(db, condition) {
    const dbFile = path.join(this.dbDir, `${db}.json`);
    
    let records = [];
    try {
      const data = await fs.readFile(dbFile, 'utf8');
      records = JSON.parse(data);
    } catch {
      return 0;
    }
    
    if (!condition || condition === '*') {
      records = [];
    } else {
      // 判断是ID还是条件
      const id = parseInt(condition);
      if (!isNaN(id)) {
        // 按ID删除
        const beforeCount = records.length;
        records = records.filter(record => record.id !== id);
        const deletedCount = beforeCount - records.length;
        
        await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
        this.databases.set(db, records);
        return deletedCount;
      } else {
        // 按条件删除（支持 key=value 格式）
        const [key, value] = condition.split('=').map(s => s.trim());
        const beforeCount = records.length;
        records = records.filter(record => record[key] !== value);
        const deletedCount = beforeCount - records.length;
        
        await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
        this.databases.set(db, records);
        return deletedCount;
      }
    }
    
    await fs.writeFile(dbFile, JSON.stringify(records, null, 2), 'utf8');
    this.databases.set(db, records);
    return records.length;
  }

  /**
   * 构建系统提示（辅助工作流，合并时不会被调用）
   */
  buildSystemPrompt() {
    return [
      '知识库 MCP：save_knowledge / query_knowledge / list_knowledge / delete_knowledge。',
      'query 为关键词子串匹配（非向量语义）。',
      'delete 须显式 condition；清空整库须 condition="*" 且 confirm=true。'
    ].join('\n');
  }

  /**
   * 同步获取知识库列表
   */
  getDatabasesSync() {
    try {
      const files = fsSync.readdirSync(this.dbDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async buildChatContext() {
    return [];
  }

  async cleanup() {
    await super.cleanup();
  }
}
