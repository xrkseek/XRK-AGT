/**
 * AI 聊天：LLM 工厂 ↔ API 端点联动（对齐原 ai-llm-settings.js）
 */
import type { LoosePayload } from '@/types';

/** LLM 端点（工厂 providers[] 条目） */
export interface LlmEndpoint {
  key?: string;
  [k: string]: unknown;
}

/** LLM 工厂 / vendor */
export interface LlmVendor {
  id?: string;
  label?: string;
  endpoints?: LlmEndpoint[];
  [k: string]: unknown;
}

/** 端点概览（profile） */
export interface LlmProfile {
  key?: string;
  factory?: string;
  model?: string;
  baseUrl?: string;
  [k: string]: unknown;
}

/** llm-options 载荷 */
export interface LlmOptions extends LoosePayload {
  vendors?: LlmVendor[];
  profiles?: LlmProfile[];
  defaultProfile?: string;
}

/** LLM 选择结果 */
export interface LlmSelection {
  factoryId: string;
  endpointKey: string;
  changed: boolean;
}

/** chat store 的 settings（仅本模块读写的字段） */
export interface ChatLlmSettings {
  llmFactory?: string;
  provider?: string;
  [k: string]: unknown;
}

export function getLlmVendors(llmOptions: LlmOptions = {}): LlmVendor[] {
  return llmOptions.vendors ?? [];
}

export function findVendorForEndpoint(
  vendors: LlmVendor[],
  endpointKey?: string | null,
): LlmVendor | null {
  if (!endpointKey) return null;
  return vendors.find((v) => v.endpoints?.some((e) => e.key === endpointKey)) || null;
}

export function getVendorEndpoints(vendors: LlmVendor[], factoryId?: string | null): LlmEndpoint[] {
  if (!factoryId) return [];
  return vendors.find((v) => v.id === factoryId)?.endpoints || [];
}

export function resolveAiLlmSelection(
  vendors: LlmVendor[],
  settings: ChatLlmSettings = {},
): LlmSelection {
  const savedFactory = settings.llmFactory || '';
  const savedProvider = settings.provider || '';
  let factoryId = savedFactory;
  let endpointKey = '';
  let changed = false;

  if (factoryId) {
    const endpoints = getVendorEndpoints(vendors, factoryId);
    if (savedProvider && endpoints.some((e) => e.key === savedProvider)) {
      endpointKey = savedProvider;
    } else if (savedProvider) {
      changed = true;
    }
  } else if (savedProvider) {
    const hit = findVendorForEndpoint(vendors, savedProvider);
    if (hit) {
      factoryId = hit.id || '';
      endpointKey = savedProvider;
      changed = true;
    } else {
      changed = true;
    }
  }

  return { factoryId, endpointKey, changed };
}

export function persistAiLlmSelection(
  settings: ChatLlmSettings,
  { factoryId, endpointKey }: { factoryId?: string; endpointKey?: string },
): void {
  settings.llmFactory = factoryId || '';
  settings.provider = endpointKey || '';
  try {
    localStorage.setItem('chatLlmFactory', settings.llmFactory || '');
    localStorage.setItem('chatProvider', settings.provider || '');
  } catch {
    /* ignore */
  }
}

export function validateChatProviderForFactory(
  llmOptions: LlmOptions,
  settings: ChatLlmSettings = {},
): string {
  const factoryId = settings.llmFactory || '';
  const endpointKey = settings.provider || '';
  if (!factoryId || !endpointKey) return endpointKey;
  const endpoints = getVendorEndpoints(getLlmVendors(llmOptions), factoryId);
  return endpoints.some((e) => e.key === endpointKey) ? endpointKey : '';
}

export function endpointMetaText(
  llmOptions: LlmOptions = {},
  factoryId = '',
  endpointKey = '',
): string {
  if (!factoryId) return '先选择 LLM 工厂，再选择该工厂下的 API 端点（providers[]）';
  const vendors = getLlmVendors(llmOptions);
  const vendor = vendors.find((v) => v.id === factoryId);
  const endpoints = vendor?.endpoints || [];
  if (!endpoints.length) {
    return `工厂「${vendor?.label || factoryId}」暂无端点，请先在配置管理中添加 providers`;
  }
  if (!endpointKey) {
    const def = llmOptions.defaultProfile || '';
    return def
      ? `未指定端点时将使用 ai-workflow.llm.Provider（${def}）`
      : '未指定端点时将使用 ai-workflow.llm.Provider 或运行时默认';
  }
  const profile = (llmOptions.profiles || []).find((p) => p.key === endpointKey);
  if (!profile) return `端点：${endpointKey}`;
  return (
    [
      profile.factory ? `工厂 ${profile.factory}` : null,
      profile.model ? `模型 ${profile.model}` : null,
      profile.baseUrl || null,
    ]
      .filter(Boolean)
      .join(' · ') || `端点：${endpointKey}`
  );
}

export function normalizeWorkspaceId(id: unknown): string {
  const s = String(id || '').trim();
  return s || 'default';
}
