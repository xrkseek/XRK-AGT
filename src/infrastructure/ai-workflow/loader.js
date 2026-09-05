import path from 'node:path';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import { resolveQualifiedCoreModuleKey } from '#utils/core-fs.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { getWorkflowRequestContext } from './workflow-request-context.js';
import { MCPServer } from '#utils/mcp-server.js';
import { FileLoader } from '#utils/file-loader.js';
import { LOADER_BATCH_SIZE } from '#utils/loader-constants.js';
import MonitorService from '#infrastructure/ai-workflow/monitor-service.js';
import { setAiWorkflowHost } from './workflow-host.js';
import { RemoteMcpController } from './remote-mcp.js';

/**
 * AI工作流加载器
 * 标准化初始化流程，避免重复加载
 */
class AiWorkflowLoader {
  workflows = new Map();
  mcpPluginServers = new Map();
  loaded = false;
  loadStats = {
    workflows: [],
    totalLoadTime: 0,
    startTime: 0,
    totalWorkflows: 0,
    failedWorkflows: 0
  };
  /** 文件 basename（无 .js）→ stream.name，热重载清理用 */
  fileKeyToWorkflowName = new Map();

  constructor() {
    this._remoteMcp = new RemoteMcpController({
      getMcpServer: () => this.mcpServer,
      getMcpPluginServers: () => this.mcpPluginServers,
      makeLog: (level, message, error) =>
        RuntimeUtil.makeLog(level, message, 'AiWorkflowLoader', error),
      registerTool: (name, def) => this.mcpServer?.registerTool?.(name, def)
    });
  }

  /** 对外仍暴露 remoteMCPServers（chat-tool-streams 等） */
  get remoteMCPServers() {
    return this._remoteMcp.remoteMCPServers;
  }

  async _disposeAllRemoteMCPServers() {
    return this._remoteMcp._disposeAllRemoteMCPServers();
  }

  /**
   * 加载所有工作流（标准化流程）
   */
  async load(isRefresh = false) {
    if (!isRefresh && this.loaded) {
      RuntimeUtil.makeLog('debug', '工作流已加载，跳过', 'AiWorkflowLoader');
      return;
    }

    try {
      this.loadStats.startTime = Date.now();
      this.loadStats.workflows = [];
      this.loadStats.failedWorkflows = 0;

      if (!isRefresh) {
        this.workflows.clear();
      }

      RuntimeUtil.makeLog('info', '开始加载工作流...', 'AiWorkflowLoader');

      // 获取所有 core 目录下的 workflow 目录
      const files = await FileLoader.getCoreSubDirFiles('workflow', {
        recursive: false
      });
      
      if (files.length === 0) {
        RuntimeUtil.makeLog('info', '未找到工作流，跳过加载', 'AiWorkflowLoader');
        this.loaded = true;
        return;
      }

      this._workflowDirsCache = await paths.getCoreSubDirs('workflow');
      // 阶段1: 加载工作流类
      await FileLoader.forEachBatch(files, LOADER_BATCH_SIZE, (file) => this.loadWorkflowClass(file));
      this._workflowDirsCache = null;

      // 阶段2: 合并 Embedding/RAG 配置到各工作流
      this.applyEmbeddingConfig(getAiWorkflowConfigOptional().embedding || {});

      // 阶段3: 初始化MCP服务（注册所有工具）
      await this.initMCP();

      this.loadStats.totalLoadTime = Date.now() - this.loadStats.startTime;
      this.loadStats.totalWorkflows = this.workflows.size;
      this.loaded = true;

      // 显示加载结果
      this.displayLoadSummary();
    } catch (error) {
      RuntimeUtil.makeLog('error', `工作流加载失败: ${error.message}`, 'AiWorkflowLoader', error);
      throw error;
    }
  }

  /**
   * 加载单个工作流类
   */
  async loadWorkflowClass(file) {
    const streamName = path.basename(file, '.js');
    const startTime = Date.now();

    try {
      const module = await FileLoader.importFresh(file);
      const StreamClass = module.default;

      if (!StreamClass || typeof StreamClass !== 'function') {
        throw new Error('无效的工作流文件');
      }

      const stream = new StreamClass();
      if (!stream.name) {
        throw new Error('工作流缺少name属性');
      }

      // Embedding配置从 runtimeConfig 自动读取，无需手动配置

      // 初始化
      if (typeof stream.init === 'function') {
        await stream.init();
      }

      // 文件键同时记 basename 与 Core 限定名，供热重载精确清理
      const qualifiedFileKey = resolveQualifiedCoreModuleKey(
        file,
        this._workflowDirsCache || [],
        'workflow'
      );
      this.fileKeyToWorkflowName.set(streamName, stream.name);
      if (qualifiedFileKey && qualifiedFileKey !== streamName) {
        this.fileKeyToWorkflowName.set(qualifiedFileKey, stream.name);
      }
      if (this.workflows.has(stream.name)) {
        RuntimeUtil.makeLog(
          'warn',
          `工作流名冲突，后加载覆盖: ${stream.name} ← ${qualifiedFileKey || streamName}`,
          'AiWorkflowLoader'
        );
      }
      this.workflows.set(stream.name, stream);

      // 若模块导出 getMcpServers，则记录插件提供的远程 MCP 服务器配置（插件式 MCP）
      if (typeof module.getMcpServers === 'function') {
        try {
          const servers = module.getMcpServers();
          if (servers && typeof servers === 'object') {
            const names = Object.keys(servers).filter(Boolean);
            if (names.length > 0) {
              RuntimeUtil.makeLog(
                'info',
                `检测到 MCP 插件服务器: ${names.join(', ')} (来自 workflow: ${stream.name})`,
                'AiWorkflowLoader'
              );
              for (const [name, runtimeConfig] of Object.entries(servers)) {
                if (!name) continue;
                this.mcpPluginServers.set(String(name), runtimeConfig || {});
              }
            }
          }
        } catch (e) {
          RuntimeUtil.makeLog('warn', `加载 MCP 插件服务器失败: ${e.message}`, 'AiWorkflowLoader');
        }
      }

      const loadTime = Date.now() - startTime;
      this.loadStats.workflows.push({
        name: stream.name,
        version: stream.version,
        loadTime,
        success: true,
        priority: stream.priority,
        mcpTools: stream.mcpTools?.size || 0
      });

      if (getAiWorkflowConfigOptional().global?.debug) {
        RuntimeUtil.makeLog('debug', `加载工作流: ${stream.name} v${stream.version} (${loadTime}ms)`, 'AiWorkflowLoader');
      }
    } catch (error) {
      this.loadStats.failedWorkflows++;
      const loadTime = Date.now() - startTime;
      const errorMessage = error.message || String(error);
      const errorStack = error.stack ? `\n${error.stack}` : '';
      this.loadStats.workflows.push({ name: streamName, loadTime, success: false, error: errorMessage });
      RuntimeUtil.makeLog('error', `工作流加载失败: ${streamName} - ${errorMessage}${errorStack}`, 'AiWorkflowLoader');
    }
  }

  /** 将 ai-workflow.embedding 合并到各工作流 embeddingConfig（无外部向量服务初始化） */
  applyEmbeddingConfig(embeddingConfig = null) {
    const config = embeddingConfig || getAiWorkflowConfigOptional().embedding || {};

    for (const stream of this.workflows.values()) {
      if (stream.embeddingConfig?.enabled === false) continue;
      if (config.enabled === false) {
        stream.embeddingConfig = { ...stream.embeddingConfig, enabled: false };
        continue;
      }
      stream.embeddingConfig = { ...stream.embeddingConfig, ...config };
    }
  }

  /**
   * 显示加载摘要
   */
  displayLoadSummary() {
    const successCount = this.workflows.size;
    const failedCount = this.loadStats.failedWorkflows;
    const totalTime = (this.loadStats.totalLoadTime / 1000).toFixed(2);

    if (failedCount > 0) {
      RuntimeUtil.makeLog('info', `工作流加载完成: 成功${successCount}个, 失败${failedCount}个, 耗时${totalTime}秒`, 'AiWorkflowLoader');
    } else {
      RuntimeUtil.makeLog('info', `工作流加载完成: ${successCount}个, 耗时${totalTime}秒`, 'AiWorkflowLoader');
    }

    // 列出工作流（仅在debug模式下）
    if (getAiWorkflowConfigOptional().global?.debug) {
      this.listWorkflowsQuiet();
    }
  }

  /**
   * 安静地列出工作流（简洁版）
   */
  listWorkflowsQuiet() {
    if (this.workflows.size === 0) return;

    RuntimeUtil.makeLog('debug', '工作流列表:', 'AiWorkflowLoader');
    
    const workflows = this.getWorkflowsByPriority();
    for (const stream of workflows) {
      const status = stream.config.enabled ? '启用' : '禁用';
      const toolCount = stream.mcpTools?.size || 0;
      
      const ragTag = stream.embeddingConfig?.enabled ? ' RAG' : '';
      RuntimeUtil.makeLog('debug',
        `  ${stream.name} v${stream.version} (${toolCount}工具, ${status}${ragTag})`,
        'AiWorkflowLoader'
      );
    }
  }

  /**
   * 重新加载工作流
   */
  async reload() {
    RuntimeUtil.makeLog('info', '开始重新加载...', 'AiWorkflowLoader');
    
    // 清理
    for (const stream of this.workflows.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    this.workflows.clear();
    this.loaded = false;
    
    // 重新加载
    await this.load();
    RuntimeUtil.makeLog('success', '重新加载完成', 'AiWorkflowLoader');
  }

  getWorkflow(name) {
    return this.workflows.get(name) || null;
  }

  getAllWorkflows() {
    return Array.from(this.workflows.values());
  }

  getEnabledWorkflows() {
    return this.getAllWorkflows().filter(s => s.config?.enabled !== false);
  }

  getWorkflowsByPriority() {
    return this.getAllWorkflows().sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const total = this.workflows.size;
    const enabled = this.getEnabledWorkflows().length;
    const totalTools = this.getAllWorkflows().reduce(
      (sum, s) => sum + (s.mcpTools?.size || 0), 0
    );
    const embeddingEnabled = this.getAllWorkflows().filter(
      s => s.embeddingConfig?.enabled
    ).length;

    return {
      total,
      enabled,
      disabled: total - enabled,
      totalTools,
      embedding: { enabled: embeddingEnabled },
      mcp: {
        toolCount: this.mcpServer?.tools?.size || 0
      },
      loadStats: this.loadStats
    };
  }

  /**
   * 创建合并工作流（主工作流 + 副工作流，仅合并 mcpTools）
   */
  mergeWorkflows(options = {}) {
    const {
      name,
      main,
      secondary = [],
      prefixSecondary = true,
      description
    } = options;

    if (!main || secondary.length === 0) {
      throw new Error('mergeWorkflows 需要主工作流和至少一个副工作流');
    }

    const mainStream = this.getWorkflow(main);
    if (!mainStream) {
      throw new Error(`主工作流未找到: ${main}`);
    }

    const secondaryStreams = secondary
      .map(n => this.getWorkflow(n))
      .filter(Boolean);

    if (secondaryStreams.length === 0) {
      throw new Error('未找到有效的副工作流');
    }

    const mergedName = name || `${main}-merged`;

    if (this.workflows.has(mergedName)) {
      return this.workflows.get(mergedName);
    }

    // 构建合并实例：克隆主工作流的原型和核心属性，独立的 mcpTools 集合
    const merged = Object.create(Object.getPrototypeOf(mainStream));
    Object.assign(merged, mainStream);
    merged.name = mergedName;
    merged.description = description || `${mainStream.description || main} + ${secondary.join(',')}`;
    merged.primaryStream = mainStream.name;
    merged.secondaryStreams = secondaryStreams.map(s => s.name);
    merged._mergedStreams = [mainStream, ...secondaryStreams];
    merged.mcpTools = new Map();

    const adoptMCPTools = (source, isPrimary) => {
      if (!source.mcpTools) return;
      for (const [tname, tconfig] of source.mcpTools.entries()) {
        const newName = (!isPrimary && prefixSecondary) ? `${source.name}.${tname}` : tname;
        if (merged.mcpTools.has(newName)) continue;
        merged.mcpTools.set(newName, {
          ...tconfig,
          source: source.name,
          primary: isPrimary
        });
      }
    };

    adoptMCPTools(mainStream, true);
    for (const s of secondaryStreams) {
      adoptMCPTools(s, false);
    }

    this.workflows.set(mergedName, merged);
    return merged;
  }

  /**
   * 清理所有资源
   */
  async cleanupAll() {
    RuntimeUtil.makeLog('info', '清理资源...', 'AiWorkflowLoader');

    for (const stream of this.workflows.values()) {
      if (typeof stream.cleanup === 'function') {
        await stream.cleanup().catch(() => {});
      }
    }

    await this._disposeAllRemoteMCPServers();

    MonitorService.reset();

    this.workflows.clear();
    this.fileKeyToWorkflowName.clear();
    this.loaded = false;

    RuntimeUtil.makeLog('success', '清理完成', 'AiWorkflowLoader');
  }

  /**
   * 清理工作流资源（优化：统一清理逻辑）
   * @private
   */
  async _cleanupWorkflow(streamName) {
    const stream = this.workflows.get(streamName)
    if (stream && typeof stream.cleanup === 'function') {
      await stream.cleanup().catch(() => {})
    }
    this.workflows.delete(streamName)
    for (const [fileKey, name] of this.fileKeyToWorkflowName) {
      if (name === streamName) this.fileKeyToWorkflowName.delete(fileKey)
    }
  }

  _workflowNameForFile(filePath) {
    const fileKey = path.basename(filePath, '.js')
    const qualified = resolveQualifiedCoreModuleKey(filePath, [], 'workflow')
    return this.fileKeyToWorkflowName.get(qualified)
      ?? this.fileKeyToWorkflowName.get(fileKey)
      ?? fileKey
  }

  /**
   * 重新加载工作流（优化：统一重载逻辑）
   * @private
   */
  async _reloadWorkflow(filePath) {
    await this.loadWorkflowClass(filePath)
    this.applyEmbeddingConfig(getAiWorkflowConfigOptional().embedding || {})
    await this.initMCP()
  }

  _registerTool(mcpServer, stream, toolName, tool) {
    if (!tool?.enabled || !mcpServer?.registerTool) return false;
    // 已是 stream.tool 或 remote 前缀则不再二次加名
    const alreadyQualified = String(toolName).includes('.');
    const fullToolName = stream.name === 'mcp' || alreadyQualified
      ? toolName
      : `${stream.name}.${toolName}`;
    mcpServer.registerTool(fullToolName, {
      description: tool.description || `执行${toolName}操作`,
      inputSchema: tool.inputSchema || {},
      handler: async (args) => {
        const context = {
          get e() {
            return getWorkflowRequestContext()?.e ?? args.e ?? null;
          },
          get turnState() {
            return getWorkflowRequestContext()?.turnState ?? null;
          },
          question: null,
          stream
        };
        try {
          if (!tool.handler) {
            return { success: false, error: 'Handler not found' };
          }
          const result = await tool.handler(args, { ...context, stream });
          let normalized;
          if (result === undefined) normalized = { success: true, message: '操作已执行' };
          else if (typeof result === 'object' && ('success' in result || 'error' in result)) normalized = result;
          else normalized = { success: true, data: result };

          // 非对外可视工具摘要写入会话历史，供下一轮 prompt（见 ChatStream.recordToolCallResult）
          if (typeof stream.recordToolCallResult === 'function') {
            try {
              const ev = context.e;
              if (ev) stream.recordToolCallResult(ev, fullToolName, normalized, args || {});
            } catch (recErr) {
              RuntimeUtil.makeLog('debug', `recordToolCallResult: ${recErr.message}`, 'AiWorkflowLoader');
            }
          }
          return normalized;
        } catch (error) {
          RuntimeUtil.makeLog('error', `MCP工具调用失败[${fullToolName}]: ${error.message}`, 'AiWorkflowLoader');
          const fail = { success: false, error: error.message };
          if (typeof stream.recordToolCallResult === 'function') {
            try {
              const ev = context.e;
              if (ev) stream.recordToolCallResult(ev, fullToolName, fail, args || {});
            } catch (recErr) {
              RuntimeUtil.makeLog('debug', `recordToolCallResult on error: ${recErr.message}`, 'AiWorkflowLoader');
            }
          }
          return fail;
        }
      }
    });
    return true;
  }

  registerMCP(mcpServer) {
    if (!mcpServer) return;
    const seen = new Set();
    for (const stream of this.workflows.values()) {
      // 合成实例工具已带二次前缀风险；只从成分流注册，LLM 白名单按成分流名匹配
      if (Array.isArray(stream?._mergedStreams) && stream._mergedStreams.length > 0) continue;
      if (!stream?.mcpTools?.size) continue;
      for (const [toolName, tool] of stream.mcpTools.entries()) {
        const alreadyQualified = String(toolName).includes('.');
        const full = stream.name === 'mcp' || alreadyQualified
          ? toolName
          : `${stream.name}.${toolName}`;
        if (seen.has(full)) {
          RuntimeUtil.makeLog('warn', `MCP 工具名冲突已跳过: ${full}`, 'AiWorkflowLoader');
          continue;
        }
        if (this._registerTool(mcpServer, stream, toolName, tool)) seen.add(full);
      }
    }
    this.mcpServer = mcpServer;
  }

  /**
   * 初始化MCP服务（如果配置启用）
   */
  async initMCP() {
    const mcpConfig = getAiWorkflowConfigOptional().mcp || {};
    if (mcpConfig.enabled === false) return;

    if (!this.mcpServer) {
      this.mcpServer = new MCPServer();
    }

    // 清空已注册工具（含远程 MCP，支持热重载）
    const existingTools = Array.from(this.mcpServer.tools.keys());
    for (const toolName of existingTools) {
      this.mcpServer.tools.delete(toolName);
    }
    
    // 重新注册所有工作流的工具
    this.registerMCP(this.mcpServer);
    const localCount = this.mcpServer.tools.size;
    
    // 加载远程MCP服务器（如果启用）
    await this.loadRemoteMCPServers();
    
    // 标记MCP服务已初始化
    this.mcpServer.initialized = true;
    const remoteCount = this.mcpServer.tools.size - localCount;
    const totalCount = this.mcpServer.tools.size;
    
    if (totalCount > 0) {
      const parts = [];
      if (localCount > 0) parts.push(`本地${localCount}个`);
      if (remoteCount > 0) parts.push(`远程${remoteCount}个`);
      const detail = parts.length > 0 ? `: ${parts.join(', ')}` : '';
      RuntimeUtil.makeLog('info', `MCP服务已挂载${detail}, 共${totalCount}个工具`, 'AiWorkflowLoader');
    }
  }

  /** 加载远程 MCP 服务器并注册工具（委托 RemoteMcpController） */
  loadRemoteMCPServers() {
    return this._remoteMcp.loadRemoteMCPServers();
  }

  /**
   * 获取已加载的远程 MCP 服务器名称列表
   * 用于在 /api/ai/models 暴露为“可选工作流”，让前端显式勾选启用。
   */
  listRemoteMCPServers() {
    return this._remoteMcp.listRemoteMCPServers();
  }
}

const aiWorkflowLoader = new AiWorkflowLoader();
setAiWorkflowHost(aiWorkflowLoader);
export default aiWorkflowLoader;