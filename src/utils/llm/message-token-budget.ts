// @ts-nocheck
import { estimateTokensMixed } from '#utils/token-estimate.js';

/**
 * 按 token 预算裁剪 messages（对齐 goose/opencode/cline：保 system + 最近尾部）。
 * 粗估，故意略偏保守。
 *
 * @param {Array<Object>} messages
 * @param {number} budgetTokens
 * @param {(text: unknown) => number} [estimate]
 * @returns {Array<Object>}
 */
export function trimMessagesToTokenBudget(messages, budgetTokens, estimate = estimateTokensMixed) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];
  const budget = Math.floor(Number(budgetTokens) || 0);
  if (budget < 500) return messages;

  const estMsg = (m) => {
    if (!m) return 0;
    if (typeof m.content === 'string') return estimate(m.content);
    if (Array.isArray(m.content)) {
      return m.content.reduce((s, p) => s + estimate(p?.text ?? p?.content ?? ''), 0);
    }
    if (m.content?.text) return estimate(m.content.text);
    if (Array.isArray(m.tool_calls)) {
      return estimate(JSON.stringify(m.tool_calls));
    }
    return estimate(JSON.stringify(m.content ?? ''));
  };

  const head = [];
  const rest = [];
  for (const m of messages) {
    if ((m?.role || '').toLowerCase() === 'system' && head.length < 3) head.push(m);
    else rest.push(m);
  }

  let used = head.reduce((s, m) => s + estMsg(m), 0);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estMsg(rest[i]);
    if (used + cost > budget && kept.length > 0) break;
    kept.push(rest[i]);
    used += cost;
  }
  kept.reverse();

  if (kept.length === rest.length) return messages;
  return [...head, ...kept];
}

/**
 * 从模型 contextWindow / maxTokens 推输入预算（留 output + buffer）。
 * @param {{ contextWindow?: number, maxTokens?: number, max_tokens?: number }} config
 * @param {{ bufferTokens?: number, ratio?: number }} [opts]
 */
export function resolveInputTokenBudget(config = {}, opts = {}) {
  const ctx = Number(config.contextWindow || config.context_window || 0);
  if (!Number.isFinite(ctx) || ctx < 1000) return 0;
  const maxOut = Number(config.maxTokens ?? config.max_tokens ?? 4096) || 4096;
  const buffer = Number(opts.bufferTokens ?? 2000) || 2000;
  const ratio = opts.ratio ?? 0.85;
  return Math.max(800, Math.floor(ctx * ratio) - maxOut - buffer);
}
