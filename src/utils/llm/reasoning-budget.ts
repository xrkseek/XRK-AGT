/**
 * Reasoning effort → budget_tokens / Anthropic output_config.effort
 * @see https://platform.claude.com/docs/en/build-with-claude/thinking
 * @see https://platform.claude.com/docs/en/build-with-claude/effort
 * @see https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */

export const REASONING_EFFORT_RATIOS = Object.freeze({
  max: 1,
  xhigh: 0.95,
  high: 0.8,
  medium: 0.5,
  low: 0.2,
  minimal: 0.1,
  none: 0,
});

type ReasoningEffort = keyof typeof REASONING_EFFORT_RATIOS;

/** Anthropic output_config.effort 官方常用档（minimal 降为 low） */
const ANTHROPIC_OUTPUT_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeReasoningEffort(effort: unknown): ReasoningEffort | undefined {
  if (effort == null || effort === '') return undefined;
  const v = String(effort).trim().toLowerCase();
  if (v in REASONING_EFFORT_RATIOS) return v as ReasoningEffort;
  return undefined;
}

export function resolveReasoningBudgetTokens(
  opts: {
    effort?: unknown;
    maxBudget?: number;
    scaleTokens?: number;
    minimumBudget?: number;
  } = {},
): number | undefined {
  const effort = normalizeReasoningEffort(opts.effort);
  if (effort === undefined) return undefined;
  const ratio = REASONING_EFFORT_RATIOS[effort];
  if (ratio <= 0) return 0;

  const maxBudget = Math.floor(Number(opts.maxBudget) || 0);
  const minimumBudget = Math.max(1, Math.floor(Number(opts.minimumBudget) || 1024));
  if (maxBudget < minimumBudget) return undefined;

  const scale = Math.floor(Number(opts.scaleTokens) || maxBudget);
  return Math.min(Math.max(Math.floor(scale * ratio), minimumBudget), maxBudget);
}

function toAnthropicOutputEffort(effort: unknown): string | undefined {
  const e = normalizeReasoningEffort(effort);
  if (!e || e === 'none') return undefined;
  if (e === 'minimal') return 'low';
  if (ANTHROPIC_OUTPUT_EFFORTS.has(e)) return e;
  return undefined;
}

function clearTemperatureUnlessExplicit(
  body: Record<string, unknown>,
  config: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  if (overrides.temperature === undefined && config.temperature === undefined) {
    delete body.temperature;
  }
}

/**
 * Anthropic Messages：thinking + effort。
 * - adaptive（推荐，Claude 4.6+ / 4.7+）：`thinking: { type: "adaptive" }` + `output_config.effort`
 * - enabled（旧版 extended thinking）：`thinking: { type: "enabled", budget_tokens }`
 * - disabled：`thinking: { type: "disabled" }`
 * thinkingType=`auto` 视为 adaptive（现行官方路径）；旧模型可显式设 `enabled`。
 */
export function applyAnthropicThinking(
  body: Record<string, any>,
  config: Record<string, any> = {},
  overrides: Record<string, any> = {},
): Record<string, any> {
  const thinkingType =
    overrides.thinkingType ??
    overrides.thinking_type ??
    config.thinkingType ??
    config.thinking_type;
  const effort =
    overrides.reasoningEffort ??
    overrides.reasoning_effort ??
    config.reasoningEffort ??
    config.reasoning_effort;

  const rawType =
    thinkingType != null && thinkingType !== ''
      ? String(thinkingType).trim().toLowerCase()
      : null;

  let type = rawType;
  if (!type) {
    const e = normalizeReasoningEffort(effort);
    if (e && e !== 'none') type = 'adaptive';
    else return body;
  }

  if (type === 'disabled') {
    body.thinking = { type: 'disabled' };
    return body;
  }

  if (type === 'adaptive' || type === 'auto') {
    body.thinking = { type: 'adaptive' };
    const outEffort = toAnthropicOutputEffort(effort);
    if (outEffort) {
      const prev =
        body.output_config && typeof body.output_config === 'object' ? body.output_config : {};
      body.output_config = { ...prev, effort: outEffort };
    }
    clearTemperatureUnlessExplicit(body, config, overrides);
    return body;
  }

  if (type !== 'enabled') return body;

  const maxTokens =
    Number(body.max_tokens ?? overrides.maxTokens ?? config.maxTokens ?? 8192) || 8192;
  // 非 interleaved：budget_tokens 须小于 max_tokens
  const maxBudget = Math.max(1024, maxTokens - 1);
  const budget = resolveReasoningBudgetTokens({
    effort: effort || 'medium',
    maxBudget,
    scaleTokens: maxBudget,
    minimumBudget: 1024,
  });

  if (budget == null || budget <= 0) {
    body.thinking = { type: 'disabled' };
    return body;
  }

  body.thinking = { type: 'enabled', budget_tokens: budget };
  clearTemperatureUnlessExplicit(body, config, overrides);
  return body;
}
