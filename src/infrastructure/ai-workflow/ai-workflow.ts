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
import { createUserVisibleTurnState, type UserVisibleTurnState } from '#utils/chat-user-visible-ack.js';
import { assembleChatLlmMessages, logLlmMessagePreview } from '#infrastructure/ai-workflow/chat-pipeline.js';
import { runHarnessModuleLoop, slimMessagesForExistingSession } from '#infrastructure/ai-workflow/harness-module-loop.js';
import { hasHarnessSession } from '#infrastructure/ai-workflow/harness-session-registry.js';
import { importHarnessSdk } from '#infrastructure/ai-workflow/harness-resolve.js';
import { normalizeError } from '#utils/normalize-error.js';

/** 出站 / callAI 消息最小面（OpenAI chat 风格） */
export type WorkflowChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
};

/** callAI / process 覆盖项（与 resolveStreamLLMConfig 并集） */
export type CallAiApiConfig = Record<string, unknown> & {
  sessionKey?: string;
  workflows?: string[];
  mergeWorkflows?: string[];
};

export type CallAiResult = {
  content: string;
  executedToolNames: string[];
  usedReplyTool?: boolean;
  toolRoundsExhausted?: boolean;
  safetyLimited?: boolean;
  sessionId?: string;
  steps?: number;
  compacted?: boolean;
  usage?: unknown;
};

/** execute / process 入站事件最小面 */
export type WorkflowEvent = {
  user_id?: string | number;
  group_id?: string | number;
  self_id?: string | number;
  msg?: string;
  reply?: (msg?: unknown, quote?: boolean, data?: Record<string, unknown>) => unknown;
  bot?: {
    nickname?: string;
    info?: { nickname?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type WorkflowQuestion =
  | string
  | { content?: string; text?: string; [key: string]: unknown };

type WorkflowRequestCtx = {
  e?: WorkflowEvent | null;
  turnState?: (UserVisibleTurnState & { slashShortCircuit?: boolean }) | null;
  toolStreamNames?: string[];
};

type McpToolDef = {
  name: string;
  handler?: unknown;
  description: string;
  inputSchema: unknown;
  enabled: boolean;
};

type MemoryMessage = {
  nickname?: string;
  message?: string;
  user_id?: string | number;
  time?: number;
  message_id?: string | number;
};

type AiWorkflowOptions = {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  priority?: number;
  config?: Record<string, unknown>;
  embedding?: { enabled?: boolean; maxContexts?: number };
  capabilities?: string[];
  frameworkToolSurface?: boolean;
  functionToggles?: Record<string, boolean | undefined>;
};

type AiWorkflowHost = {
  getWorkflow?: (name: string) => AiWorkflow | undefined;
  mergeWorkflows?: (opts: {
    name: string;
    main: string;
    secondary: string[];
    prefixSecondary?: boolean;
  }) => AiWorkflow;
};

type HarnessErr = Error & { code?: string };

function workflowCtx(): WorkflowRequestCtx | null {
  return getWorkflowRequestContext() as WorkflowRequestCtx | null;
}

function errMsg(err: unknown): string {
  return normalizeError(err).message;
}

function messageTextContent(m: WorkflowChatMessage): string {
  const content = m.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const obj = content as { text?: string };
    return obj.text || '';
  }
  return '';
}

export default class AiWorkflow {
  name: string;
  description: string;
  version: string;
  author: string;
  priority: number;
  capabilities: string[];
  frameworkToolSurface: boolean;
  config: Record<string, unknown> & {
    enabled?: boolean;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
  };
  functionToggles: Record<string, boolean | undefined>;
  embeddingConfig: { enabled: boolean; maxContexts: number };
  /** MCP 工具注册表 */
  mcpTools = new Map<string, McpToolDef>();
  /** mergeWorkflows 合成实例挂载的子工作流 */
  _mergedStreams: AiWorkflow[] = [];
  _initialized = false;

  constructor(options: AiWorkflowOptions = {}) {
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

  async init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
  }

  estimateTokens(text: unknown) {
    return estimateTokensMixed(text);
  }

  compressText(text: string, maxLength = 150) {
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
  async storeMessageMemory(groupId: string | number, message: MemoryMessage) {
    if (!this.embeddingConfig?.enabled) return;

    const messageText = `${message.nickname}: ${message.message}`;
    const userId = String(message.user_id || groupId);

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
    } catch (e: unknown) {
      RuntimeUtil.makeLog('debug', `[${this.name}] 存储消息失败: ${errMsg(e)}`, 'AiWorkflow');
    }
  }

  /** 从短期记忆做关键词召回（非向量 RAG）。需 embedding.enabled。 */
  async retrieveRelevantContexts(groupId: string | number, query: string) {
    if (!query || !this.embeddingConfig?.enabled) return [];

    try {
      const userId = String(groupId || '').replace(/^memory_/, '');
      const memories = await MemoryManager.searchShortTermMemories(userId, query, 5);
      return memories.map((m) => {
        const meta = (m as { metadata?: { nickname?: string } }).metadata;
        return {
          message: String(m.content ?? ''),
          similarity: typeof (m as { score?: number }).score === 'number'
            ? (m as { score: number }).score
            : 0.5,
          time: m.timestamp as number | undefined,
          userId,
          nickname: String(meta?.nickname || '')
        };
      });
    } catch (error: unknown) {
      RuntimeUtil.makeLog('debug', `[${this.name}] 检索上下文失败: ${errMsg(error)}`, 'AiWorkflow');
      return [];
    }
  }

  async retrieveKnowledgeContexts(query: string) {
    if (!this._mergedStreams || !query) return [];

    for (const stream of this._mergedStreams) {
      const retrieve = (stream as AiWorkflow & {
        retrieveKnowledgeContexts?: (
          q: string,
          max?: number
        ) => Promise<Array<{ content?: string; similarity?: number; source?: string }>>;
      }).retrieveKnowledgeContexts;
      if (typeof retrieve === 'function') {
        const maxContexts = this.embeddingConfig?.maxContexts || 3;
        const contexts = await retrieve.call(stream, query, maxContexts);
        if (contexts && contexts.length > 0) {
          return contexts;
        }
      }
    }
    return [];
  }

  async buildEnhancedContext(
    e: WorkflowEvent | null | undefined,
    question: WorkflowQuestion,
    baseMessages: WorkflowChatMessage[]
  ) {
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
        if (msg?.role === 'user') {
          if (typeof msg.content === 'string') {
            query = msg.content;
            break;
          } else if (msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content)) {
            const text = (msg.content as { text?: string }).text;
            if (text) {
              query = text;
              break;
            }
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
        ...historyContexts.map((ctx) => ({
          type: 'history' as const,
          message: ctx.message,
          similarity: ctx.similarity || 0,
          source: '历史对话'
        })),
        ...knowledgeContexts.map((ctx) => ({
          type: 'knowledge' as const,
          message: String(ctx.content ?? ''),
          similarity: ctx.similarity || 0.5,
          source: ctx.source || '知识库'
        }))
      ];

      const optimizedContexts = allContexts.slice(0, 5);
      if (optimizedContexts.length === 0) return baseMessages;

      const enhanced = [...baseMessages];
      const contextParts: string[] = [];
      const historyItems = optimizedContexts.filter((c) => c.type === 'history');
      const knowledgeItems = optimizedContexts.filter((c) => c.type === 'knowledge');

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
          const first = enhanced[0];
          first.content = String(first.content ?? '') + contextPrompt;
        } else {
          enhanced.unshift({
            role: 'system',
            content: contextPrompt
          });
        }
      }

      return enhanced;
    } catch (error: unknown) {
      RuntimeUtil.makeLog('debug',
        `[${this.name}] 构建上下文失败: ${errMsg(error)}`,
        'AiWorkflow'
      );
      return baseMessages;
    }
  }

  registerMCPTool(
    name: string,
    options: {
      handler?: unknown;
      description?: string;
      inputSchema?: unknown;
      enabled?: boolean;
    } = {}
  ) {
    const {
      handler,
      description = '',
      inputSchema = {},
      enabled = true
    } = options;

    const toolDef: McpToolDef = {
      name,
      handler,
      description,
      inputSchema,
      enabled: this.functionToggles[name] ?? enabled
    };

    this.mcpTools.set(name, toolDef);
  }

  buildSystemPrompt(_opts: Record<string, unknown> = {}): string | Promise<string> {
    return '';
  }

  /**
   * 在 system 文案末尾注入工作区上下文（agents/workspace 模板、agents/rules、skills、MEMORY、subagents），
   * 受 ai-workflow.agentWorkspace 控制。
   */
  async finalizeSystemPromptContent(text: string, opts: Record<string, unknown> = {}) {
    if (text == null || text === '') text = '';
    const streamKey = String(this.name || '').replace(/-merged$/, '') || this.name;
    const aux = collectAuxiliaryStreamPrompts(this);
    const merged = aux ? `${text}${aux}` : text;
    return appendAgentWorkspaceToPrompt(merged, getAiWorkflowConfigOptional(), streamKey, opts);
  }

  /** 默认：仅 system；子类可覆写以拼多轮。提示词由 buildSystemPrompt + agentWorkspace 注入。 */
  async buildChatContext(e: WorkflowEvent | null | undefined, question: WorkflowQuestion) {
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
   * 出站：prepareOutboundMessages = contextWindow trim；tool 环走 harness。
   */
  async callAI(
    messages: WorkflowChatMessage[],
    apiConfig: CallAiApiConfig = {}
  ): Promise<CallAiResult | null> {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      RuntimeUtil.makeLog('warn', '[AiWorkflow] callAI 消息数组为空', 'AiWorkflow');
      return null;
    }

    const reqCtx = workflowCtx();
    const config = applyPromptCachePolicy(this.resolveLLMConfig(apiConfig), {
      stream: this,
      e: (reqCtx?.e ?? null) as any,
    });

    const overrides = this.buildCallOverrides(config, apiConfig);
    const e = reqCtx?.e ?? null;
    const ctor = this.constructor as typeof AiWorkflow & {
      getEventHistoryKey?: (ev: WorkflowEvent | null) => string | null;
    };
    const sessionKey = overrides.sessionKey
      ?? apiConfig.sessionKey
      ?? (typeof ctor.getEventHistoryKey === 'function'
        ? ctor.getEventHistoryKey(e)
        : null);

    let toPrepare = Array.isArray(messages) ? messages : [];
    if (sessionKey) {
      try {
        const harness = await importHarnessSdk();
        if (hasHarnessSession(harness as Parameters<typeof hasHarnessSession>[0], sessionKey)) {
          // Prior turns already in harness session — don't trim discarded history.
          toPrepare = slimMessagesForExistingSession(toPrepare) as WorkflowChatMessage[];
        }
      } catch {
        /* SDK missing: keep full messages; loop will throw clearly */
      }
    }

    const outbound = await this.prepareOutboundMessages(toPrepare, config);

    const inputTokens = outbound.reduce((sum, m) => {
      return sum + this.estimateTokens(messageTextContent(m));
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
        ...(harnessResult?.compacted ? { compacted: true as const } : {}),
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
    } catch (err: unknown) {
      const he = err as HarnessErr;
      if (he?.code === 'empty_turn' || /empty llm response/i.test(String(he?.message || ''))) {
        RuntimeUtil.makeLog('warn', `[${this.name}] AI 连续空响应，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (he?.code === 'session_busy') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness session busy，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (he?.code === 'context_overflow') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness context overflow，放弃本轮`, 'AiWorkflow');
        return null;
      }
      if (he?.code === 'unsupported_content') {
        RuntimeUtil.makeLog('warn', `[${this.name}] harness unsupported content，放弃本轮`, 'AiWorkflow');
        return null;
      }
      throw err;
    }
  }

  resolveLLMConfig(apiConfig: CallAiApiConfig = {}) {
    const merged = resolveStreamLLMConfig(this, apiConfig);
    return this.patchLLMConfig(merged, apiConfig);
  }

  /**
   * 出站硬裁：resolveInputTokenBudget(contextWindow) → trimMessagesToTokenBudget。
   * harness soft budget（同源 formula）见 resolveHarnessCompaction；两层叠加见 docs/agent-context.md §5.1。
   */
  async prepareOutboundMessages(
    messages: WorkflowChatMessage[],
    config: Record<string, unknown> = {}
  ): Promise<WorkflowChatMessage[]> {
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
      outbound = trimmed as WorkflowChatMessage[];
    }
    return outbound;
  }

  /**
   * 工作流级 LLM 配置补丁（业务场景扩展点）。
   * 子类可追加场景字段；request body 仍由各 *LLMClient.buildBody 按官方文档组装。
   */
  patchLLMConfig(merged: Record<string, unknown>, _apiConfig: CallAiApiConfig = {}) {
    return merged;
  }

  /** 组装 overrides（工具白名单等）；MCP tool 环走 harness，不经工厂执行。 */
  buildCallOverrides(resolvedConfig: Record<string, unknown>, apiConfig: CallAiApiConfig = {}) {
    return {
      ...resolvedConfig,
      ...apiConfig,
      workflows: apiConfig.workflows ?? this._getToolWorkflowNames()
    };
  }

  async execute(e: WorkflowEvent, question: WorkflowQuestion, config: CallAiApiConfig) {
    const run = async () => {
      const traceId = MonitorService.startTrace(this.name, {
        agentId: e?.user_id,
        workflow: this.name,
        userId: e?.user_id
      });

      try {
        const messages = await assembleChatLlmMessages(this, e, question);
        const turnEarly = workflowCtx()?.turnState;
        if (turnEarly?.slashShortCircuit) {
          MonitorService.endTrace(traceId, { success: true, response: turnEarly.lastOutboundSummary || '' });
          return turnEarly.lastOutboundSummary || '';
        }
        MonitorService.addStep(traceId, { step: 'build_context', messages: messages.length });
        logLlmMessagePreview(this, messages, 'AiWorkflow');

        const result = await this.callAI(messages as WorkflowChatMessage[], config);
        const responseText = result?.content ?? '';
        MonitorService.addStep(traceId, { step: 'ai_call', responseLength: responseText?.length || 0 });

        if (!responseText?.trim()) {
          MonitorService.endTrace(traceId, { success: false, error: 'No response' });
          return null;
        }

        if (e?.reply) {
          await Promise.resolve(e.reply(responseText.trim())).catch((err: unknown) => {
            RuntimeUtil.makeLog('debug', `发送回复失败: ${errMsg(err)}`, 'AiWorkflow');
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
      } catch (error: unknown) {
        const message = errMsg(error);
        MonitorService.recordError(traceId, error as Error);
        MonitorService.endTrace(traceId, { success: false, error: message });
        RuntimeUtil.makeLog('error',
          `工作流执行失败[${this.name}]: ${message}`,
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
   * - 未传 mergeWorkflows：开放模式 — 裸主流 + frameworkToolSurface（remote-mcp.* 不自动并入）
   * - 传了 mergeWorkflows（数组，可空）：严格模式 — 名单即工具面；remote-mcp.* 与普通 workflow 一样须显式列入
   */
  async process(e: WorkflowEvent, question: WorkflowQuestion, options: CallAiApiConfig = {}) {
    try {
      const {
        mergeWorkflows,
        workflows: workflowsOpt,
        ...apiConfig
      } = options;

      const host = getAiWorkflowHost() as AiWorkflowHost | null | undefined;
      const strict = Array.isArray(mergeWorkflows);
      const { mergeable, toolOnly } = partitionToolStreamNames(
        strict ? (mergeWorkflows as string[]) : [],
      );

      const missing: string[] = [];
      const secondary: string[] = [];
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

      let stream: AiWorkflow = this;
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

      let toolStreamNames: string[];
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
    } catch (error: unknown) {
      RuntimeUtil.makeLog('error', `工作流处理失败[${this.name}]: ${errMsg(error)}`, 'AiWorkflow');
      return null;
    }
  }

  successResponse(data: Record<string, unknown>) {
    return {
      success: true as const,
      data: {
        ...data,
        timestamp: Date.now()
      }
    };
  }

  errorResponse(code: string, message: string) {
    return {
      success: false as const,
      error: { code, message }
    };
  }

  async cleanup() {
    RuntimeUtil.makeLog('debug', `[${this.name}] 清理资源`, 'AiWorkflow');
    this._initialized = false;
  }
}
