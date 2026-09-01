import RuntimeUtil from '#utils/runtime-util.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import MemoryManager from '#infrastructure/ai-workflow/memory-manager.js';
import MonitorService from '#infrastructure/ai-workflow/monitor-service.js';
import { getAiWorkflowHost } from '#infrastructure/ai-workflow/workflow-host.js';
import { appendAgentWorkspaceToPrompt } from '#utils/agent-workspace.js';
import { estimateTokensMixed } from '#utils/token-estimate.js';
import { applyPromptCachePolicy } from '#utils/llm/prompt-cache-policy.js';
import { resolveStreamLLMConfig } from '#utils/llm/llm-config-resolve.js';
import {
  resolveInputTokenBudget,
  trimMessagesToTokenBudget
} from '#utils/llm/message-token-budget.js';
import {
  getWorkflowRequestContext,
  runWithWorkflowRequestContext
} from '#infrastructure/ai-workflow/workflow-request-context.js';
import {
  collectAuxiliaryStreamPrompts,
  expandChatToolWorkflowWhitelist,
  partitionToolStreamNames,
  resolveToolStreamNames,
} from '#infrastructure/ai-workflow/chat-tool-streams.js';
import { normalizeStringArray } from '#utils/string-array-utils.js';
import { createUserVisibleTurnState } from '#utils/chat-user-visible-ack.js';
import { assembleChatLlmMessages, logLlmMessagePreview } from '#infrastructure/ai-workflow/chat-pipeline.js';
import { runHarnessModuleLoop, slimMessagesForExistingSession } from '#infrastructure/ai-workflow/harness-module-loop.js';
import { hasHarnessSession } from '#infrastructure/ai-workflow/harness-session-registry.js';
import { importHarnessSdk } from '#infrastructure/ai-workflow/harness-resolve.js';

export default class AiWorkflow {
  /** @type {Map<string, object>} MCP 工具注册表 */
  mcpTools = new Map();
  /** @type {AiWorkflow[]} mergeWorkflows 合成实例挂载的子工作流 */
  _mergedStreams = [];
  _initialized = false;

  /**
   * 构造函数
   * @param {Object} options - 选项
   * @param {string} options.name - 工作流名称
   * @param {string} options.description - 描述
   * @param {string} options.version - 版本
   * @param {string} options.author - 作者
   * @param {number} options.priority - 优先级
   * @param {Object} options.config - 配置
   * @param {Object} options.embedding - Embedding配置
   * @param {string[]} [options.capabilities] - 能力标签（如 tools/prompt）
   * @param {boolean} [options.frameworkToolSurface] - 是否自动并入 chat 工具白名单
   */
  constructor(options = {}) {
    this.name = options.name || 'base-stream';
    this.description = options.description || '基础工作流';
    this.version = options.version || '1.0.5';
    this.author = options.author || 'unknown';
    this.priority = options.priority || 100;
    this.capabilities = Array.isArray(options.capabilities) ? options.capabilities : [];
    this.frameworkToolSurface = options.frameworkToolSurface === true;

    this.config = {
      enabled: true,
      temperature: 0.8,
      maxTokens: 6000,
      topP: 0.9,
      presencePenalty: 0.6,
      frequencyPenalty: 0.6,
      ...options.config
    };

    this.functionToggles = options.functionToggles || {};

    this.embeddingConfig = {
      enabled: options.embedding?.enabled ?? true,
      maxContexts: options.embedding?.maxContexts || 5
    };
  }

  /**
   * 初始化工作流
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
  }

  /**
   * 估算文本token数量
   * @param {string} text - 待估算的文本
   * @returns {number} token数量
   */
  estimateTokens(text) {
    return estimateTokensMixed(text);
  }

  /**
   * 压缩文本到指定长度
   * @param {string} text - 待压缩的文本
   * @param {number} maxLength - 最大长度
   * @returns {string} 压缩后的文本
   */
  compressText(text, maxLength = 150) {
    if (!text || text.length <= maxLength) return text;
    
    const sentences = text.split(/[。！？.!?]/);
    let compressed = '';
    for (const sentence of sentences) {
      if ((compressed + sentence).length > maxLength) break;
      compressed += sentence;
    }
    
    if (compressed.length === 0 || compressed.length > maxLength) {
      compressed = text.substring(0, maxLength - 3) + '...';
    }
    
    return compressed;
  }

  /**
   * 写入进程内短期记忆（embedding.enabled 时）。
   * 主对话历史仍由 ChatStream.messageHistory / memory 工作流负责；此处供 retrieveRelevantContexts 关键词召回。
   */
  async storeMessageMemory(groupId, message) {
    if (!this.embeddingConfig?.enabled) return;

    const messageText = `${message.nickname}: ${message.message}`;
    const userId = message.user_id || groupId;

    try {
      MemoryManager.addShortTermMemory(userId, {
        role: 'user',
        content: messageText,
        metadata: {
          groupId,
          nickname: message.nickname,
          time: message.time || Date.now(),
          messageId: message.message_id
        }
      });
    } catch (e) {
      RuntimeUtil.makeLog('debug', `[${this.name}] 存储消息失败: ${e.message}`, 'AiWorkflow');
    }
  }

  /**
   * 从短期记忆做关键词召回（非向量 RAG）。需 embedding.enabled。
   */
  async retrieveRelevantContexts(groupId, query) {
    if (!query || !this.embeddingConfig?.enabled) return [];

    try {
      const userId = String(groupId || '').replace(/^memory_/, '');
      const memories = await MemoryManager.searchShortTermMemories(userId, query, 5);
      return memories.map((m) => ({
        message: m.content,
        similarity: typeof m.score === 'number' ? m.score : 0.5,
        time: m.timestamp,
        userId,
        nickname: m.metadata?.nickname || ''
      }));
    } catch (error) {
      RuntimeUtil.makeLog('debug', `[${this.name}] 检索上下文失败: ${error.message}`, 'AiWorkflow');
      return [];
    }
  }

  /**
   * 检索知识库上下文
   * @param {string} query - 查询文本
   * @returns {Promise<Array<Object>>}
   */
  async retrieveKnowledgeContexts(query) {
    if (!this._mergedStreams || !query) return [];

    // 从合并的工作流中查找支持知识检索的工作流
    for (const stream of this._mergedStreams) {
      if (typeof stream.retrieveKnowledgeContexts === 'function') {
        const maxContexts = this.embeddingConfig?.maxContexts || 3;
        const contexts = await stream.retrieveKnowledgeContexts(query, maxContexts);
        if (contexts && contexts.length > 0) {
          return contexts;
        }
      }
    }
    return [];
  }

  /**
   * 构建增强上下文（RAG）
   * @param {Object} e - 事件对象
   * @param {string|Object} question - 问题
   * @param {Array<Object>} baseMessages - 基础消息列表
   * @returns {Promise<Array<Object>>}
   */
  async buildEnhancedContext(e, question, baseMessages) {
    const groupId = e ? (e.group_id || `private_${e.user_id}`) : 'default';

    let query = '';
    if (typeof question === 'string') {
      query = question;
    } else if (question && typeof question === 'object') {
      query = question.content || question.text || '';
    }

    if (!query && Array.isArray(baseMessages)) {
      for (let i = baseMessages.length - 1; i >= 0; i--) {
        const msg = baseMessages[i];
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            query = msg.content;
            break;
          } else if (msg.content?.text) {
            query = msg.content.text;
            break;
          }
        }
      }
    }

    if (!query) {
      return baseMessages;
    }

    try {
      const historyContexts = this.embeddingConfig?.enabled
        ? await this.retrieveRelevantContexts(groupId, query)
        : [];

      const knowledgeContexts = await this.retrieveKnowledgeContexts(query);
      const allContexts = [
        ...historyContexts.map(ctx => ({
          type: 'history',
          message: ctx.message,
          similarity: ctx.similarity || 0,
          source: '历史对话'
        })),
        ...knowledgeContexts.map(ctx => ({
          type: 'knowledge',
          message: ctx.content,
          similarity: ctx.similarity || 0.5,
          source: ctx.source || '知识库'
        }))
      ];

      const optimizedContexts = allContexts.slice(0, 5);
      if (optimizedContexts.length === 0) return baseMessages;

      const enhanced = [...baseMessages];
      const contextParts = [];
      const historyItems = optimizedContexts.filter(c => c.type === 'history');
      const knowledgeItems = optimizedContexts.filter(c => c.type === 'knowledge');

      if (historyItems.length > 0) {
        contextParts.push(
          '【相关历史对话】',
          historyItems.map((ctx, i) =>
            `${i + 1}. ${this.compressText(ctx.message, 120)}${ctx.similarity ? ` (相关度: ${(ctx.similarity * 100).toFixed(0)}%)` : ''}`
          ).join('\n')
        );
      }

      if (knowledgeItems.length > 0) {
        contextParts.push(
          '【相关知识库】',
          knowledgeItems.map((ctx, i) =>
            `${i + 1}. [${ctx.source}] ${this.compressText(ctx.message, 120)}`
          ).join('\n')
        );
      }

      if (contextParts.length > 0) {
        const contextPrompt = contextParts.join('\n\n') + '\n\n以上是相关上下文，可参考但不要重复。\n';

        if (enhanced[0]?.role === 'system') {
          enhanced[0].content += contextPrompt;
        } else {
          enhanced.unshift({
            role: 'system',
            content: contextPrompt
          });
        }
      }

      return enhanced;
    } catch (error) {
      RuntimeUtil.makeLog('debug',
        `[${this.name}] 构建上下文失败: ${error.message}`,
        'AiWorkflow'
      );
      return baseMessages;
    }
  }

  /**
   * 注册MCP工具（MCP Protocol，用于外部工具调用）
   * @param {string} name - 工具名称
   * @param {Object} options - 选项
   * @param {Function} options.handler - 处理函数
   * @param {string} options.description - 描述
   * @param {Object} options.inputSchema - 输入Schema（JSON Schema格式）
   * @param {boolean} options.enabled - 是否启用
   */
  registerMCPTool(name, options = {}) {
    const {
      handler,
      description = '',
      inputSchema = {},
      enabled = true
    } = options;

    const toolDef = {
      name,
      handler,
      description,
      inputSchema,
      enabled: this.functionToggles[name] ?? enabled
    };

    this.mcpTools.set(name, toolDef);
  }


  /**
   * 构建系统提示（子类可重写）
   * @param {Object} context - 上下文
   * @returns {string}
   */
  buildSystemPrompt() {
    return '';
  }

  /**
   * 在 system 文案末尾注入工作区上下文（agents/workspace 模板、agents/rules、skills、MEMORY、subagents），
   * 受 `ai-workflow.agentWorkspace` 控制。
   * 覆盖 buildChatContext 的子类若自行组装 system，应调用本方法以保持一致行为。
   * @param {string} text
   * @returns {Promise<string>}
   */
  async finalizeSystemPromptContent(text, opts = {}) {
    if (text == null || text === '') text = '';
    const streamKey = String(this.name || '').replace(/-merged$/, '') || this.name;
    const aux = collectAuxiliaryStreamPrompts(this);
    const merged = aux ? `${text}${aux}` : text;
    return appendAgentWorkspaceToPrompt(merged, getAiWorkflowConfigOptional(), streamKey, opts);
  }

  /**
   * 构建聊天上下文
   * @param {Object} e - 事件对象
   * @param {string|Object} question - 问题
   * @returns {Promise<Array<Object>>}
   */
  /**
   * 默认：仅 system；子类可覆写以拼多轮。提示词由 buildSystemPrompt + agentWorkspace 注入。
   */
  async buildChatContext(e, question) {
    const systemPrompt = await this.buildSystemPrompt({ e, question });
    if (!systemPrompt) return [];
    const userText = typeof question === 'string'
      ? question
      : (question?.text ?? question?.content ?? e?.msg ?? '');
    const content = await this.finalizeSystemPromptContent(systemPrompt, {
      userText: String(userText || '')
    });
    return [{ role: 'system', content }];
  }

  /** 工具流名单：优先请求 ALS（process 写入），无则按流自身解析 */
  _getToolWorkflowNames() {
    const names = resolveToolStreamNames(this);
    RuntimeUtil.makeLog('debug', `[AiWorkflow] 工具白名单 ${this.name}: [${names.join(', ')}]`, 'AiWorkflow');
    return names;
  }

  /**
   * 调用AI（非流式，支持tool calling）
   * @returns {Promise<{ content: string, executedToolNames: string[], usedReplyTool?: boolean, toolRoundsExhausted?: boolean }|null>}
   */
  async callAI(messages, apiConfig = {}) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      RuntimeUtil.makeLog('warn', '[AiWorkflow] callAI 消息数组为空', 'AiWorkflow');
      return null;
    }

    const config = applyPromptCachePolicy(this.resolveLLMConfig(apiConfig), {
      stream: this,
      e: getWorkflowRequestContext()?.e ?? null,
    });

    const overrides = this.buildCallOverrides(config, apiConfig);
    const e = getWorkflowRequestContext()?.e ?? null;
    const sessionKey = overrides.sessionKey
      ?? apiConfig.sessionKey
      ?? (typeof this.constructor.getEventHistoryKey === 'function'
        ? this.constructor.getEventHistoryKey(e)
        : null);

    let toPrepare = Array.isArray(messages) ? messages : [];
    if (sessionKey) {
      try {
        const harness = await importHarnessSdk();
        if (hasHarnessSession(harness, sessionKey)) {
          // Prior turns already in harness session — don't trim discarded history.
          toPrepare = slimMessagesForExistingSession(toPrepare);
        }
      } catch {
        /* SDK missing: keep full messages; loop will throw clearly */
      }
    }

    const outbound = await this.prepareOutboundMessages(toPrepare, config);

    const inputTokens = outbound.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : (m.content?.text || '');
      return sum + this.estimateTokens(content);
    }, 0);
    const traceId = this.name;
    MonitorService.recordTokens(traceId, { input: inputTokens });

    // Provider 重试由 harness llmRetry 负责；此处只吞 empty_turn
    try {
      const harnessResult = await runHarnessModuleLoop({
        stream: this,
        messages: outbound,
        config: { ...config, ...overrides },
        apiConfig: {
          ...overrides,
          ...(sessionKey ? { sessionKey: String(sessionKey) } : {}),
        },
      });
      const content = harnessResult?.content != null ? String(harnessResult.content) : '';
      const executedToolNames = harnessResult?.executedToolNames || [];
      const usedReplyTool = !!harnessResult?.usedReplyTool;
      const meta = {
        ...(harnessResult?.sessionId ? { sessionId: harnessResult.sessionId } : {}),
        ...(harnessResult?.steps != null ? { steps: harnessResult.steps } : {}),
        ...(harnessResult?.compacted ? { compacted: true } : {}),
        ...(harnessResult?.usage ? { usage: harnessResult.usage } : {}),
      };
      MonitorService.recordTokens(traceId, { output: this.estimateTokens(content) });
      if (harnessResult?.safetyLimited) {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness session safety 触发上限，结束本轮`, 'AiWorkflow');
        return { content, executedToolNames, usedReplyTool, safetyLimited: true, ...meta };
      }
      if (harnessResult?.toolRoundsExhausted) {
        return { content, executedToolNames, usedReplyTool, toolRoundsExhausted: true, ...meta };
      }
      if (content.trim()) return { content, executedToolNames, usedReplyTool, ...meta };
      if (usedReplyTool || executedToolNames.length > 0) {
        return { content: '', executedToolNames, usedReplyTool, ...meta };
      }
      RuntimeUtil.makeLog('warn', `[${this.name}] AI 空响应，放弃本轮`, 'AiWorkflow');
      return null;
    } catch (err) {
      if (err?.code === 'empty_turn' || /empty llm response/i.test(String(err?.message || ''))) {
        RuntimeUtil.makeLog('warn', `[${this.name}] AI 连续空响应，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (err?.code === 'session_busy') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness session busy，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (err?.code === 'context_overflow') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness context overflow，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (err?.code === 'unsupported_content') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness unsupported content，放弃本轮`, 'AiWorkflow');
        return null;
      }
      throw err;
    }
  }





  resolveLLMConfig(apiConfig = {}) {
    const merged = resolveStreamLLMConfig(this, apiConfig);
    return this.patchLLMConfig(merged, apiConfig);
  }

  /**
   * 出站消息准备：按 contextWindow 裁剪。
   * 多轮压缩 / soft budget 由 harness CompactionOptions 负责。
   */
  async prepareOutboundMessages(messages, config = {}) {
    let outbound = Array.isArray(messages) ? messages : [];
    const budget = resolveInputTokenBudget(config);
    if (budget > 0) {
      const trimmed = trimMessagesToTokenBudget(outbound, budget, (t) => this.estimateTokens(t));
      if (trimmed.length < outbound.length) {
        RuntimeUtil.makeLog(
          'info',
          `[${this.name}] 按 contextWindow 裁剪消息 ${outbound.length}→${trimmed.length}（budget≈${budget}）`,
          'AiWorkflow'
        );
      }
      outbound = trimmed;
    }
    return outbound;
  }

  /**
   * 工作流级 LLM 配置补丁（业务场景扩展点）。
   * 子类可追加场景字段；request body 仍由各 *LLMClient.buildBody 按官方文档组装。
   * @param {object} merged - resolveStreamLLMConfig 产物
   * @param {object} apiConfig - 本次调用覆盖
   * @returns {object}
   */
  patchLLMConfig(merged, _apiConfig = {}) {
    return merged;
  }

  /**
   * 组装 overrides（工具白名单等）；MCP tool 环走 harness，不经工厂执行。
   */
  buildCallOverrides(resolvedConfig, apiConfig = {}) {
    return {
      ...resolvedConfig,
      ...apiConfig,
      workflows: apiConfig.workflows ?? this._getToolWorkflowNames()
    };
  }

  /**
   * 执行工作流
   * @param {Object} e - 事件对象
   * @param {string|Object} question - 问题
   * @param {Object} config - 配置
   * @returns {Promise<string|null>}
   */
  async execute(e, question, config) {
    const run = async () => {
      const traceId = MonitorService.startTrace(this.name, {
        agentId: e?.user_id,
        workflow: this.name,
        userId: e?.user_id
      });

      try {
        const messages = await assembleChatLlmMessages(this, e, question);
        const turnEarly = getWorkflowRequestContext()?.turnState;
        if (turnEarly?.slashShortCircuit) {
          MonitorService.endTrace(traceId, { success: true, response: turnEarly.lastOutboundSummary || '' });
          return turnEarly.lastOutboundSummary || '';
        }
        MonitorService.addStep(traceId, { step: 'build_context', messages: messages.length });
        logLlmMessagePreview(this, messages, 'AiWorkflow');

        const result = await this.callAI(messages, config);
        const responseText = result?.content ?? '';
        MonitorService.addStep(traceId, { step: 'ai_call', responseLength: responseText?.length || 0 });

        if (!responseText?.trim()) {
          MonitorService.endTrace(traceId, { success: false, error: 'No response' });
          return null;
        }

        if (e?.reply) {
          await e.reply(responseText.trim()).catch(err => {
            RuntimeUtil.makeLog('debug', `发送回复失败: ${err.message}`, 'AiWorkflow');
          });
        }

        if (this.embeddingConfig.enabled && e) {
          const groupId = e.group_id || `private_${e.user_id}`;
          this.storeMessageMemory(groupId, {
            user_id: e.self_id,
            nickname: e.bot?.nickname || e.bot?.info?.nickname || 'AgentRuntime',
            message: responseText,
            message_id: Date.now().toString(),
            time: Date.now()
          }).catch(() => { });
        }

        MonitorService.endTrace(traceId, { success: true, response: responseText });
        return responseText;
      } catch (error) {
        MonitorService.recordError(traceId, error);
        MonitorService.endTrace(traceId, { success: false, error: error.message });
        RuntimeUtil.makeLog('error',
          `工作流执行失败[${this.name}]: ${error.message}`,
          'AiWorkflow'
        );
        return null;
      }
    };

    if (getWorkflowRequestContext()) return run();
    return runWithWorkflowRequestContext({ e, turnState: createUserVisibleTurnState() }, run);
  }

  /**
   * 处理请求。
   *
   * - 未传 `mergeWorkflows`：开放模式 — 裸主流 + frameworkToolSurface（remote-mcp.* 不自动并入）
   * - 传了 `mergeWorkflows`（数组，可空）：严格模式 — 名单即工具面；`remote-mcp.*` 与普通 workflow 一样须显式列入，只进白名单不 merge；
   *   未加载的副流名忽略并打 warn，不拖垮整次调用
   */
  async process(e, question, options = {}) {
    try {
      const {
        mergeWorkflows,
        workflows: workflowsOpt,
        ...apiConfig
      } = options;

      const host = getAiWorkflowHost();
      const strict = Array.isArray(mergeWorkflows);
      const { mergeable, toolOnly } = partitionToolStreamNames(
        strict ? mergeWorkflows : [],
      );

      const missing = [];
      const secondary = [];
      for (const name of mergeable) {
        if (host?.getWorkflow?.(name)) secondary.push(name);
        else missing.push(name);
      }
      if (missing.length) {
        RuntimeUtil.makeLog(
          'warn',
          `副工作流未加载已忽略: ${missing.join(', ')}`,
          'AiWorkflow',
        );
      }

      let stream = this;
      if (secondary.length > 0) {
        const mergedName = `${this.name}-${secondary.join('-')}`;
        stream = host?.getWorkflow?.(mergedName) ||
          host?.mergeWorkflows?.({
            name: mergedName,
            main: this.name,
            secondary,
            prefixSecondary: true,
          }) ||
          this;
      }

      let toolStreamNames;
      if (Array.isArray(workflowsOpt)) {
        toolStreamNames = normalizeStringArray(workflowsOpt);
      } else if (strict) {
        toolStreamNames = [this.name, ...secondary, ...toolOnly];
      } else {
        toolStreamNames = expandChatToolWorkflowWhitelist([this.name]);
      }
      apiConfig.workflows = toolStreamNames;

      return await runWithWorkflowRequestContext(
        { e, turnState: null, toolStreamNames },
        () => stream.execute(e, question, apiConfig),
      );
    } catch (error) {
      RuntimeUtil.makeLog('error', `工作流处理失败[${this.name}]: ${error.message}`, 'AiWorkflow');
      return null;
    }
  }

  /**
   * MCP 工具成功返回（system-Core 各 workflow 通用）
   * @param {Object} data
   * @returns {{ success: true, data: Object }}
   */
  successResponse(data) {
    return {
      success: true,
      data: {
        ...data,
        timestamp: Date.now()
      }
    };
  }

  /**
   * MCP 工具失败返回
   * @param {string} code
   * @param {string} message
   * @returns {{ success: false, error: { code: string, message: string } }}
   */
  errorResponse(code, message) {
    return {
      success: false,
      error: { code, message }
    };
  }

  /**
   * 清理资源
   * @returns {Promise<void>}
   */
  async cleanup() {
    RuntimeUtil.makeLog('debug', `[${this.name}] 清理资源`, 'AiWorkflow');
    this._initialized = false;
  }
}