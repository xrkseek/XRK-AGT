import RuntimeUtil from '#utils/runtime-util.js'
import { countVisionInContent } from '#utils/llm/vision-content.js'
import { resolveSlashCommand } from '#utils/slash-commands.js'
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js'

/**
 * LLM 消息组装（工作流 / HTTP 共用）。
 *
 * 稳定分层（内容语义对齐 Yunzai，实现仍走本仓库 Loader / AiWorkflow）：
 * 0. 斜杠命令展开（/recipe · /skill）
 * 1. `buildChatContext` — `system`（人设+协议+工作区）+ 当前用户消息骨架
 * 2. `mergeMessageHistory` — 群/会话笔录为 user 块（【我】/【我·工具】/他人），当前轮 `[当前消息]`
 * 3. `buildEnhancedContext` — 易变切片（时间/会话/主人）插入 system 后，勿塞进 system 以免搅乱前缀缓存
 *
 * 视觉：入口统一为 `{ text, images[], replyImages[] }`（见 vision-content.js），
 * 出站由各 LLM 工厂经 message-transform 转为 OpenAI parts / 厂商协议。
 *
 * 工具调用轨迹：用户可见靠 reply MCP；下一轮延续靠 `recordToolCallResult`，不往用户气泡贴「使用了」。
 */

type ChatMessage = {
  role?: string
  content?: unknown
  [key: string]: unknown
}

type QuestionObject = {
  content?: unknown
  text?: unknown
  [key: string]: unknown
}

/** 方法签名用 bivariant，避免 AiWorkflow 具体参数与 unknown 逆变冲突 */
type ChatPipelineStream = {
  name?: string
  buildChatContext(e: unknown, question: unknown): Promise<ChatMessage[]> | ChatMessage[]
  mergeMessageHistory?(messages: ChatMessage[], e: unknown): Promise<ChatMessage[]> | ChatMessage[]
  buildEnhancedContext?(
    e: unknown,
    question: unknown,
    messages: ChatMessage[]
  ): Promise<ChatMessage[]> | ChatMessage[]
}

type PipelineEvent = {
  reply?: (msg?: unknown) => unknown | Promise<unknown>
  [key: string]: unknown
}

type SlashResolved = {
  handled?: boolean
  replyOnly?: string
  text?: string
  systemExtra?: string
}

function applySlashToQuestion(question: unknown): {
  question: unknown
  systemExtra: string
  replyOnly: string | null
} {
  let text = ''
  if (typeof question === 'string') text = question
  else if (question && typeof question === 'object' && !Array.isArray(question)) {
    const q = question as QuestionObject
    text = String(q.content ?? q.text ?? '')
  }
  if (!text.trim().startsWith('/')) {
    return { question, systemExtra: '', replyOnly: null }
  }
  const resolved = resolveSlashCommand(text) as SlashResolved
  if (!resolved.handled) return { question, systemExtra: '', replyOnly: null }
  if (resolved.replyOnly) {
    return { question, systemExtra: '', replyOnly: resolved.replyOnly }
  }
  if (typeof question === 'string') {
    return {
      question: resolved.text || question,
      systemExtra: resolved.systemExtra || '',
      replyOnly: null
    }
  }
  if (question && typeof question === 'object' && !Array.isArray(question)) {
    const next: QuestionObject = { ...(question as QuestionObject) }
    if (next.content != null) next.content = resolved.text || next.content
    else next.text = resolved.text || next.text
    return { question: next, systemExtra: resolved.systemExtra || '', replyOnly: null }
  }
  return { question, systemExtra: resolved.systemExtra || '', replyOnly: null }
}

function injectSystemExtra(messages: ChatMessage[], systemExtra: string): ChatMessage[] {
  if (!systemExtra || !Array.isArray(messages) || !messages.length) return messages
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${systemExtra}` }, ...messages.slice(1)]
  }
  return [{ role: 'system', content: systemExtra }, ...messages]
}

export async function assembleChatLlmMessages(
  stream: ChatPipelineStream,
  e: PipelineEvent | null | undefined,
  question: unknown
): Promise<ChatMessage[]> {
  const slash = applySlashToQuestion(question)
  if (slash.replyOnly) {
    if (e?.reply) {
      try {
        await e.reply(slash.replyOnly)
      } catch {
        /* ignore */
      }
    }
    const turn = getWorkflowRequestContext()?.turnState
    if (turn) {
      turn.replyFlushed = true
      turn.slashShortCircuit = true
      turn.lastOutboundSummary = slash.replyOnly
    }
    return []
  }

  const q = slash.question
  const questionObj =
    q != null && typeof q === 'object' && !Array.isArray(q) ? (q as QuestionObject) : null
  const enhancedQuestion = questionObj ?? (Array.isArray(q) ? undefined : q)

  let messages: ChatMessage[] = Array.isArray(q)
    ? (q as ChatMessage[])
    : await stream.buildChatContext(e, questionObj ?? q)

  messages = injectSystemExtra(messages, slash.systemExtra)

  if (e && typeof stream.mergeMessageHistory === 'function') {
    messages = await stream.mergeMessageHistory(messages, e)
  }
  if (typeof stream.buildEnhancedContext === 'function') {
    messages = await stream.buildEnhancedContext(e, enhancedQuestion, messages)
  }
  return messages
}

/** 调试：LLM 消息预览（role + 文本摘要 + 多模态图数量） */
export function previewLlmMessages(messages: ChatMessage[] | null | undefined) {
  return (messages || []).map((m, idx) => {
    const role = m.role || `msg${idx}`
    let text: unknown = m.content
    let imageCount = 0
    if (typeof text === 'object' && text !== null && !Array.isArray(text)) {
      imageCount = countVisionInContent(text)
      const obj = text as { text?: string; content?: unknown }
      text = obj.text || obj.content || ''
    } else if (Array.isArray(m.content)) {
      imageCount = countVisionInContent(m.content)
      text = m.content
        .filter((p): p is { type?: string; text?: string } => !!p && typeof p === 'object')
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('')
    }
    return {
      idx,
      role,
      text: String(text ?? ''),
      imageCount,
      multimodal: imageCount > 0
    }
  })
}

/** 统一 debug 日志：最终送入 LLM 的消息结构 */
export function logLlmMessagePreview(
  stream: { name?: string } | null | undefined,
  messages: ChatMessage[],
  tag = 'AiWorkflow'
) {
  try {
    RuntimeUtil.makeLog(
      'debug',
      `[${stream?.name || tag}] LLM消息预览: ${JSON.stringify(previewLlmMessages(messages), null, 2)}`,
      tag
    )
  } catch {
    /* ignore */
  }
}
