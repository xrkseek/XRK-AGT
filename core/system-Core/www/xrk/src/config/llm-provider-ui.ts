/**
 * LLM provider 条目在配置页的展示分组（对齐原 modules/llm-provider-ui.js）
 */
import type { LoosePayload } from '@/types';

/** provider 字段分组 */
export interface ProviderFieldGroup {
  id: string;
  label: string;
  collapsible?: boolean;
  keys: string[];
}

/** 分组后的展示区块 */
export interface ProviderSchemaSection extends Partial<ProviderFieldGroup> {
  id: string;
  label: string;
  entries: Array<[string, unknown]>;
}

export const LLM_PROVIDER_FIELD_GROUPS: ProviderFieldGroup[] = [
  {
    id: 'identity',
    label: '标识',
    keys: ['key', 'label', 'protocol'],
  },
  {
    id: 'connection',
    label: '连接与认证',
    keys: ['baseUrl', 'path', 'apiKey', 'authMode', 'authHeaderName'],
  },
  {
    id: 'model',
    label: '模型',
    keys: ['model', 'deployment', 'apiVersion', 'anthropicVersion', 'region', 'instructions'],
  },
  {
    id: 'sampling',
    label: '采样与输出',
    collapsible: true,
    keys: [
      'temperature',
      'maxTokens',
      'maxOutputTokens',
      'tokenField',
      'topP',
      'topK',
      'presencePenalty',
      'frequencyPenalty',
      'stop',
      'responseFormat',
      'thinkingType',
      'reasoningEffort',
      'serviceTier',
      'anthropicServiceTier',
      'promptCacheKey',
      'promptCacheRetention',
      'safetyIdentifier',
      'maxToolCalls',
    ],
  },
  {
    id: 'tools',
    label: '工具调用',
    collapsible: true,
    keys: ['enableTools', 'toolChoice', 'parallelToolCalls', 'maxToolRounds', 'stripToolTraces'],
  },
  {
    id: 'runtime',
    label: '运行与网络',
    collapsible: true,
    keys: ['timeout', 'enableStream', 'proxy', 'headers', 'extraBody'],
  },
];

/** 按分组过滤排序 schema 字段；未命中的进「其他」 */
export function groupProviderSchemaFields(fields: LoosePayload = {}): ProviderSchemaSection[] {
  const fieldMap = new Map<string, unknown>(Object.entries(fields ?? {}));
  const used = new Set<string>();
  const sections: ProviderSchemaSection[] = [];

  for (const group of LLM_PROVIDER_FIELD_GROUPS) {
    const entries: Array<[string, unknown]> = group.keys
      .filter((key) => fieldMap.has(key))
      .map((key) => [key, fieldMap.get(key)]);
    if (!entries.length) continue;
    entries.forEach(([key]) => used.add(key));
    sections.push({ ...group, entries });
  }

  const rest = [...fieldMap.entries()].filter(([key]) => !used.has(key));
  if (rest.length) {
    sections.push({ id: 'other', label: '其他', entries: rest });
  }

  return sections;
}

export function isLlmProvidersArray(path = ''): boolean {
  return /(?:^|\.)providers$/.test(String(path || ''));
}

export function getProviderEntrySummary(item: LoosePayload = {}): string {
  const key = item.key || item.provider || '—';
  const label = item.label ? ` · ${item.label}` : '';
  const model = item.model || item.chatModel || '';
  const base = item.baseUrl || '';
  const modelPart = model ? ` · ${model}` : '';
  const basePart = base ? ` · ${base}` : '';
  return `${key}${label}${modelPart}${basePart}`;
}
