import { estimateTokensMixed } from '#utils/token-estimate.js';

type MessageLike = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
};

type EstimateFn = (text: unknown) => number;

/**
 * 按 token 预算裁剪 messages（对齐 goose/opencode/cline：保 system + 最近尾部）。
 * 粗估，故意略偏保守。
 */
export function trimMessagesToTokenBudget(
  messages: MessageLike[],
  budgetTokens: number,
  estimate: EstimateFn = estimateTokensMixed,
): MessageLike[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  const budget = Math.floor(Number(budgetTokens) || 0);
  if (budget < 500) return messages;

  const estMsg = (m: MessageLike | null | undefined): number => {
    if (!m) return 0;
    if (typeof m.content === 'string') return estimate(m.content);
    if (Array.isArray(m.content)) {
      return m.content.reduce(
        (s: number, p: any) => s + estimate(p?.text ?? p?.content ?? ''),
        0,
      );
    }
    if (m.content && typeof m.content === 'object' && 'text' in (m.content as object)) {
      return estimate((m.content as { text?: unknown }).text);
    }
    if (Array.isArray(m.tool_calls)) {
      return estimate(JSON.stringify(m.tool_calls));
    }
    return estimate(JSON.stringify(m.content ?? ''));
  };

  const head: MessageLike[] = [];
  const rest: MessageLike[] = [];
  for (const m of messages) {
    if ((m?.role || '').toLowerCase() === 'system' && head.length < 3) head.push(m);
    else rest.push(m);
  }

  let used = head.reduce((s, m) => s + estMsg(m), 0);
  const kept: MessageLike[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estMsg(rest[i]);
    if (used + cost > budget && kept.length > 0) break;
    kept.push(rest[i]!);
    used += cost;
  }
  kept.reverse();

  if (kept.length === rest.length) return messages;
  return [...head, ...kept];
}

/**
 * 从模型 contextWindow / maxTokens 推输入预算（留 output + buffer）。
 */
export function resolveInputTokenBudget(
  config: {
    contextWindow?: number;
    context_window?: number;
    maxTokens?: number;
    max_tokens?: number;
  } = {},
  opts: { bufferTokens?: number; ratio?: number } = {},
): number {
  const ctx = Number(config.contextWindow || config.context_window || 0);
  if (!Number.isFinite(ctx) || ctx < 1000) return 0;
  const maxOut = Number(config.maxTokens ?? config.max_tokens ?? 4096) || 4096;
  const buffer = Number(opts.bufferTokens ?? 2000) || 2000;
  const ratio = opts.ratio ?? 0.85;
  return Math.max(800, Math.floor(ctx * ratio) - maxOut - buffer);
}
