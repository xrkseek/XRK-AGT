/**
 * Provider variants（对齐 opencode variants 轻量版）：
 * providers[].variants.{id} = { reasoningEffort?, thinkingType?, temperature?, maxTokens?, extraBody? }
 * 选中：providers[].variant 或 apiConfig.variant
 */

type VariantPack = Record<string, unknown> & {
  extraBody?: Record<string, unknown>;
};

type ProviderConfigLike = {
  variant?: unknown;
  variants?: Record<string, VariantPack> | unknown;
  extraBody?: Record<string, unknown>;
};

type ApiConfigLike = {
  variant?: unknown;
};

/**
 * @returns 叠加 variant 后的补丁（浅字段）
 */
export function resolveProviderVariantPatch(
  providerConfig: ProviderConfigLike = {},
  apiConfig: ApiConfigLike = {},
): Record<string, unknown> {
  const variantId = String(apiConfig.variant ?? providerConfig.variant ?? '').trim();
  if (!variantId) return {};

  const variants = providerConfig.variants;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return {};

  const pack = (variants as Record<string, VariantPack>)[variantId];
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return {};

  const patch: Record<string, unknown> = {};
  for (const key of [
    'reasoningEffort',
    'reasoning_effort',
    'thinkingType',
    'thinking_type',
    'temperature',
    'topP',
    'top_p',
    'maxTokens',
    'max_tokens',
    'maxOutputTokens',
    'toolChoice',
    'tool_choice',
  ]) {
    if (pack[key] !== undefined) patch[key] = pack[key];
  }
  if (pack.extraBody && typeof pack.extraBody === 'object') {
    patch.extraBody = { ...(providerConfig.extraBody || {}), ...pack.extraBody };
  }
  patch._variant = variantId;
  return patch;
}
