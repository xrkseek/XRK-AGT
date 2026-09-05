type ExpressLikeRes = {
  write: (chunk: string) => unknown;
  flush?: () => unknown;
  setHeader: (name: string, value: string) => unknown;
  flushHeaders?: () => unknown;
};

/** 写入 OpenAI 风格 SSE data 行 */
export function writeSSEChunk(res: ExpressLikeRes, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/** 构造 chat.completion.chunk 事件体 */
export function createOpenAIChunk({
  id,
  created,
  model,
  index = 0,
  delta = {},
  finishReason = null,
  usage,
  mcpTools,
  extra = {},
}: {
  id?: unknown;
  created?: unknown;
  model?: unknown;
  index?: number;
  delta?: Record<string, unknown>;
  finishReason?: string | null;
  usage?: unknown;
  mcpTools?: unknown[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    ...extra,
  };

  if (Object.keys(delta || {}).length > 0 || finishReason !== null || usage) {
    chunk.choices = [
      {
        index,
        delta,
        finish_reason: finishReason,
      },
    ];
  }

  if (usage) chunk.usage = usage;
  if (Array.isArray(mcpTools) && mcpTools.length > 0) chunk.mcp_tools = mcpTools;

  return chunk;
}

/** v3 chat/completions 流式响应头 */
export function initOpenAIChatSSE(res: ExpressLikeRes): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/**
 * OpenAI chat.completion.chunk 增量回调（文本 / reasoning / mcp_tools / tool_calls）
 */
export function createOpenAiWorkflowDeltaHandler(
  res: ExpressLikeRes,
  { id, created, model }: { id?: unknown; created?: unknown; model?: unknown } = {},
): {
  callback: (delta: unknown, metadata?: Record<string, unknown>) => void;
  getStats: () => { totalContent: string; chunkCount: number };
} {
  let totalContent = '';
  let isFirstChunk = true;
  let chunkCount = 0;

  const callback = (delta: unknown, metadata: Record<string, unknown> = {}) => {
    const hasTextDelta = typeof delta === 'string' && delta.length > 0;
    const hasMcpTools = Array.isArray(metadata?.mcp_tools) && metadata.mcp_tools.length > 0;
    const hasToolCalls = Array.isArray(metadata?.tool_calls) && metadata.tool_calls.length > 0;
    const hasReasoningDelta =
      typeof metadata?.reasoning_content === 'string' &&
      (metadata.reasoning_content as string).length > 0;

    if (!hasTextDelta && !hasMcpTools && !hasToolCalls && !hasReasoningDelta) return;

    if (hasTextDelta) {
      totalContent += delta as string;
      chunkCount += 1;
      writeSSEChunk(
        res,
        createOpenAIChunk({
          id,
          created,
          model,
          delta: isFirstChunk
            ? { role: 'assistant', content: delta as string }
            : { content: delta as string },
          finishReason: null,
        }),
      );
      isFirstChunk = false;
    }

    if (hasReasoningDelta) {
      writeSSEChunk(
        res,
        createOpenAIChunk({
          id,
          created,
          model,
          delta: isFirstChunk
            ? { role: 'assistant', reasoning_content: metadata.reasoning_content }
            : { reasoning_content: metadata.reasoning_content },
          finishReason: null,
        }),
      );
      isFirstChunk = false;
    }

    if (hasMcpTools && !hasTextDelta) {
      writeSSEChunk(
        res,
        createOpenAIChunk({
          id,
          created,
          model,
          mcpTools: metadata.mcp_tools as unknown[],
        }),
      );
    }

    if (hasToolCalls) {
      writeSSEChunk(
        res,
        createOpenAIChunk({
          id,
          created,
          model,
          delta: { tool_calls: metadata.tool_calls },
          finishReason: null,
        }),
      );
    }
  };

  return {
    callback,
    getStats: () => ({ totalContent, chunkCount }),
  };
}

/** 发送 finish chunk + [DONE] */
export function finishOpenAIChatStream(
  res: ExpressLikeRes,
  {
    id,
    created,
    model,
    totalContent,
    usageMessages,
    extractMessageText,
    estimateTokens,
  }: {
    id?: unknown;
    created?: unknown;
    model?: unknown;
    totalContent: string;
    usageMessages: unknown;
    extractMessageText: (messages: unknown) => string;
    estimateTokens: (text: string) => number;
  },
): void {
  const promptText = extractMessageText(usageMessages);
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(totalContent);

  writeSSEChunk(
    res,
    createOpenAIChunk({
      id,
      created,
      model,
      delta: {},
      finishReason: 'stop',
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
  );
  res.write('data: [DONE]\n\n');
}

/** 流式错误 chunk + [DONE] */
export function writeOpenAiWorkflowError(
  res: ExpressLikeRes,
  {
    id,
    created,
    model,
    error,
  }: {
    id?: unknown;
    created?: unknown;
    model?: unknown;
    error?: { message?: string } | null;
  },
): void {
  writeSSEChunk(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    error: {
      message: error?.message || 'Internal server error',
      type: 'server_error',
      code: 'internal_error',
    },
  });
  res.write('data: [DONE]\n\n');
}

/**
 * 执行 client.chatStream 并写入 OpenAI SSE 事件
 */
export async function pipeOpenAIChatCompletionsStream(
  res: ExpressLikeRes,
  {
    client,
    messages,
    overrides,
    id,
    created,
    model,
    usageMessages,
    extractMessageText,
    estimateTokens,
    runWrapped,
  }: {
    client: {
      chatStream: (
        messages: unknown,
        callback: (delta: unknown, metadata?: Record<string, unknown>) => void,
        overrides?: unknown,
      ) => Promise<unknown>;
    };
    messages: unknown;
    overrides?: unknown;
    id?: unknown;
    created?: unknown;
    model?: unknown;
    usageMessages: unknown;
    extractMessageText: (messages: unknown) => string;
    estimateTokens: (text: string) => number;
    runWrapped?: (fn: () => Promise<unknown>) => Promise<unknown>;
  },
): Promise<string> {
  const { callback, getStats } = createOpenAiWorkflowDeltaHandler(res, { id, created, model });
  await (typeof runWrapped === 'function'
    ? runWrapped(() => client.chatStream(messages, callback, overrides))
    : client.chatStream(messages, callback, overrides));

  const { totalContent } = getStats();
  finishOpenAIChatStream(res, {
    id,
    created,
    model,
    totalContent,
    usageMessages,
    extractMessageText,
    estimateTokens,
  });
  return totalContent;
}
