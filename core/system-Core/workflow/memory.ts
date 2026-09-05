// @ts-nocheck
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import RuntimeUtil from '#utils/runtime-util.js';
import MemoryManager from '#infrastructure/ai-workflow/memory-manager.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

/**
 * 记忆系统工作流插件
 * 
 * 所有功能都通过 MCP 工具提供：
 * - query_memory（查询记忆）
 * - list_memories（列出记忆）
 * - save_memory（保存记忆）
 * - delete_memory（删除记忆）
 */
export default class MemoryStream extends AiWorkflow {
  memoryDir = path.join(os.homedir(), '.xrk', 'memory');
  memories = new Map();

  constructor() {
    super({
      name: 'memory',
      description: '记忆系统工作流插件',
      version: '1.0.5',
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
    
    // 确保记忆目录存在
    await fs.mkdir(this.memoryDir, { recursive: true });

    // 注册记忆相关功能
    this.registerAllFunctions();
    
    // 加载记忆数据
    await this.loadMemories();

  }

  /**
   * 注册所有记忆相关功能
   */
  registerAllFunctions() {
    /**
     * 保存长期记忆
     * 
     * @description 将重要信息保存为长期记忆，支持跨会话持久化存储。记忆会与用户ID和场景关联。
     * 
     * @param {string} content - 记忆内容（必填）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {string} returns.data.memoryId - 记忆的唯一ID
     * @returns {string} returns.data.message - 操作结果消息
     * @returns {string} returns.data.content - 记忆内容的前100个字符（预览）
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * { content: "用户喜欢喝咖啡，不喜欢茶" }
     */
    this.registerMCPTool('save_memory', {
      description: '保存长期记忆。记忆会跨会话持久化存储，与用户ID和场景关联，可通过 query_memory 查询。',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '记忆内容（简洁明确，便于检索）'
          }
        },
        required: ['content']
      },
      handler: async (args = {}, context = {}) => {
        const { content } = args;
        if (!content) return { success: false, error: '记忆内容不能为空' };

        const memoryId = await this.saveMemory(content, context);
        RuntimeUtil.makeLog('info', `[${this.name}] 保存记忆 #${memoryId}: ${content.slice(0, 50)}...`, 'MemoryStream');
        
        return {
          success: true,
          data: {
            memoryId,
            message: '记忆保存成功',
            content: content.slice(0, 100)
          }
        };
      },
      enabled: true
    });

    /**
     * 查询记忆
     * 
     * @description 根据关键词查询相关的长期记忆，支持语义搜索。返回匹配的记忆列表，按时间倒序排列。
     * 
     * @param {string} keyword - 搜索关键词（必填）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {string} returns.data.keyword - 搜索的关键词
     * @returns {Array} returns.data.memories - 匹配的记忆列表，每个元素包含 { id, content, userId, scene, timestamp, createdAt }
     * @returns {number} returns.data.count - 匹配的记忆数量
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * { keyword: "咖啡" }
     */
    this.registerMCPTool('query_memory', {
      description: '查询长期记忆。根据关键词进行语义搜索，返回相关的记忆列表，按时间倒序排列。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '搜索关键词（支持语义搜索）'
          }
        },
        required: ['keyword']
      },
      handler: async (args = {}, context = {}) => {
        const { keyword } = args;
        if (!keyword) return { success: false, error: '关键词不能为空' };

        const memories = await this.queryMemories(keyword, context);
        RuntimeUtil.makeLog('info', `[${this.name}] 查询记忆 "${keyword}"，找到 ${memories.length} 条`, 'MemoryStream');

        return {
          success: true,
          data: {
            keyword,
            memories,
            count: memories.length
          }
        };
      },
      enabled: true
    });

    /**
     * 删除记忆
     * 
     * @description 根据记忆ID删除指定的长期记忆。只能删除当前用户的记忆。
     * 
     * @param {string} id - 记忆ID（必填）
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功删除
     * @returns {Object} returns.data - 结果数据对象
     * @returns {string} returns.data.id - 记忆ID
     * @returns {string} returns.data.message - 操作结果消息
     * @returns {string} returns.error - 失败时的错误信息
     * 
     * @example
     * { id: "1234567890" }
     */
    this.registerMCPTool('delete_memory', {
      description: '删除长期记忆。根据记忆ID删除指定的记忆，只能删除当前用户的记忆。需要先通过 query_memory 或 list_memories 获取记忆ID。',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '记忆ID'
          }
        },
        required: ['id']
      },
      handler: async (args = {}, context = {}) => {
        const { id } = args;
        if (!id) return { success: false, error: '记忆ID不能为空' };

        const success = await this.deleteMemory(id, context);
        RuntimeUtil.makeLog('info', `[${this.name}] ${success ? '删除' : '删除失败'}记忆 #${id}`, 'MemoryStream');
        
        return {
          success,
          data: {
            id,
            message: success ? '记忆删除成功' : '记忆删除失败，可能不存在或无权限'
          }
        };
      },
      enabled: true
    });

    /**
     * 列出所有记忆
     * 
     * @description 列出当前用户在当前场景下保存的所有长期记忆，按时间倒序排列。
     * 
     * @param {} 无需参数
     * 
     * @returns {Object} 返回结果对象
     * @returns {boolean} returns.success - 是否成功
     * @returns {Object} returns.data - 成功时的数据对象
     * @returns {Array} returns.data.memories - 记忆列表，每个元素包含 { id, content, userId, scene, timestamp, createdAt }
     * @returns {number} returns.data.count - 记忆数量
     * 
     * @example
     * // 调用示例
     * {}
     * 
     * // 返回示例
     * {
     *   success: true,
     *   data: {
     *     memories: [...],
     *     count: 5
     *   }
     * }
     */
    this.registerMCPTool('list_memories', {
      description: '列出所有长期记忆。返回当前用户在当前场景下的所有记忆，按时间倒序排列。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        const memories = await this.listMemories(context);
        RuntimeUtil.makeLog('info', `[${this.name}] 列出记忆，共 ${memories.length} 条`, 'MemoryStream');

        return {
          success: true,
          data: {
            memories,
            count: memories.length
          }
        };
      },
      enabled: true
    });
  }

  /**
   * 获取用户ID（统一方法）
   */
  getUserId(context) {
    return context?.e?.user_id || context?.e?.user?.id || 'default';
  }

  /**
   * 获取场景（统一方法）
   */
  getScene(context) {
    return context?.scene || 'default';
  }

  /**
   * 保存记忆
   */
  async saveMemory(content, context) {
    const userId = this.getUserId(context);
    
    const memoryId = await MemoryManager.addLongTermMemory(userId, {
      content,
      type: 'fact',
      importance: 0.7,
      metadata: {
        scene: this.getScene(context),
        source: this.name
      }
    });

    const memory = {
      id: memoryId,
      content,
      userId,
      scene: this.getScene(context),
      timestamp: Date.now(),
      createdAt: new Date().toISOString()
    };

    this.memories.set(memoryId, memory);
    await this.saveMemoryToFile(memory);
    
    return memoryId;
  }

  /**
   * 查询记忆
   */
  async queryMemories(keyword, context) {
    const userId = this.getUserId(context);
    
    const memories = await MemoryManager.searchLongTermMemories(userId, keyword, 10);
    
    const scene = this.getScene(context);
    const results = memories
      .filter(m => m.metadata?.scene === scene || !scene)
      .map(m => ({
        id: m.id,
        content: m.content,
        userId: m.userId,
        scene: m.metadata?.scene || 'default',
        timestamp: m.timestamp,
        createdAt: new Date(m.timestamp).toISOString()
      }));
    
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 删除记忆
   */
  async deleteMemory(id, context) {
    const userId = this.getUserId(context);
    const memory = this.memories.get(id);
    
    if (!memory || memory.userId !== userId) {
      return false;
    }

    MemoryManager.deleteLongTermMemory(userId, id);
    this.memories.delete(id);
    await this.deleteMemoryFile(id);
    
    return true;
  }

  /**
   * 列出记忆
   */
  async listMemories(context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    
    const results = [];
    for (const memory of this.memories.values()) {
      if (memory.userId === userId && memory.scene === scene) {
        results.push(memory);
      }
    }
    
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 保存记忆到文件
   */
  async saveMemoryToFile(memory) {
    const userId = memory.userId;
    const scene = memory.scene;
    const memoryFile = path.join(this.memoryDir, `${userId}_${scene}.json`);
    
    try {
      let memories = [];
      try {
        const data = await fs.readFile(memoryFile, 'utf8');
        memories = JSON.parse(data);
      } catch {
        // 文件不存在，创建新数组
      }
      
      // 更新或添加记忆
      const index = memories.findIndex(m => m.id === memory.id);
      if (index >= 0) {
        memories[index] = memory;
      } else {
        memories.push(memory);
      }
      
      await fs.writeFile(memoryFile, JSON.stringify(memories, null, 2), 'utf8');
    } catch (error) {
      RuntimeUtil.makeLog('error', `[${this.name}] 保存记忆到文件失败: ${error.message}`, 'MemoryStream');
    }
  }

  /**
   * 从文件删除记忆
   */
  async deleteMemoryFile(id) {
    // 遍历所有记忆文件，找到并删除对应的记忆
    try {
      const files = await fs.readdir(this.memoryDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const memoryFile = path.join(this.memoryDir, file);
          try {
            const data = await fs.readFile(memoryFile, 'utf8');
            const memories = JSON.parse(data);
            const filtered = memories.filter(m => m.id !== id);
            if (filtered.length !== memories.length) {
              await fs.writeFile(memoryFile, JSON.stringify(filtered, null, 2), 'utf8');
              break;
            }
          } catch {
            // 忽略错误
          }
        }
      }
    } catch (error) {
      RuntimeUtil.makeLog('error', `[${this.name}] 从文件删除记忆失败: ${error.message}`, 'MemoryStream');
    }
  }

  /**
   * 加载记忆数据
   */
  async loadMemories() {
    try {
      const files = await fs.readdir(this.memoryDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const memoryFile = path.join(this.memoryDir, file);
          try {
            const data = await fs.readFile(memoryFile, 'utf8');
            const memories = JSON.parse(data);
            for (const memory of memories) {
              this.memories.set(memory.id, memory);
            }
          } catch {
            // 忽略错误
          }
        }
      }
    } catch {
      // 目录不存在，忽略
    }
  }

  /**
   * 获取用户场景的记忆（用于构建prompt）
   */
  async getMemoriesForContext(context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    
    const memories = await MemoryManager.searchLongTermMemories(userId, '', 10);
    
    return memories
      .filter(m => m.metadata?.scene === scene || !scene)
      .map(m => ({
        id: m.id,
        content: m.content,
        userId: m.userId,
        scene: m.metadata?.scene || 'default',
        timestamp: m.timestamp
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * 构建系统提示（辅助工作流，合并时不会被调用）
   */
  buildSystemPrompt() {
    return '记忆系统插件，为其他工作流提供记忆能力。';
  }

  /**
   * 获取记忆用于prompt展示
   * 注意：此方法用于在主工作流中展示记忆信息，不用于MCP工具
   */
  async getMemoriesForPrompt(context) {
    const userId = this.getUserId(context);
    const scene = this.getScene(context);
    
    const shortTerm = MemoryManager.getShortTermMemories(userId, 5);
    const longTerm = await MemoryManager.searchLongTermMemories(userId, '', 5);
    
    return [
      ...shortTerm.map(m => ({
        id: m.id,
        content: m.content,
        timestamp: m.timestamp
      })),
      ...longTerm
        .filter(m => m.metadata?.scene === scene || !scene)
        .map(m => ({
          id: m.id,
          content: m.content,
          timestamp: m.timestamp
        }))
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  }

  async buildChatContext() {
    return [];
  }

  async cleanup() {
    await super.cleanup();
  }
}
