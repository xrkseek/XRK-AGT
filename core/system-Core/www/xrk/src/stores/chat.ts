import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { normalizeWorkspaceId } from '@/chat/llm-settings';
import {
  clearChatHistoryStorage,
  loadChatHistory,
  saveChatHistory,
} from '@/chat/history';
import { clearStoredChatScroll } from '@/chat/scroll';
import type { ChatMode, HistoryItem, LoosePayload } from '@/types';

/** AI 模式下选中的 MCP 工具工作流 key（存 localStorage / 传给后端） */
export type WorkflowKey = string;

export interface WorkspacePreset {
  id: string;
  label: string;
  [k: string]: any;
}

export interface LlmSelection {
  factoryId?: string;
  endpointKey?: string;
}

export const useChatStore = defineStore('chat', () => {
  const mode = ref<ChatMode>(normalizeMode(localStorage.getItem('chatMode')));
  const settings = reactive({
    persona: localStorage.getItem('chatPersona') || '',
    provider: localStorage.getItem('chatProvider') || '',
    llmFactory: localStorage.getItem('chatLlmFactory') || '',
    workspace: normalizeWorkspaceId(localStorage.getItem('chatWorkspace')),
    workflows: [] as WorkflowKey[],
    /** true when localStorage never had chatWorkflows (apply preferred MCP defaults once) */
    workflowsUnset: false,
  });
  const llmOptions = ref<LoosePayload | null>(null);
  const workspacePresets = ref<WorkspacePreset[]>([{ id: 'default', label: '默认工作区' }]);

  /** 与原版三键兼容；启动时从 localStorage 恢复 */
  const histories = reactive({
    ai: loadChatHistory('ai'),
    event: loadChatHistory('event'),
    voice: loadChatHistory('voice'),
  }) as Record<ChatMode, HistoryItem[]>;

  /** null = never set → ChatView applies preferred defaults once */
  const initialWorkflows = readWorkflows();
  settings.workflows = ((initialWorkflows ?? []) as unknown[])
    .map((w) => String((w as LoosePayload)?.key || (w as LoosePayload)?.name || w))
    .filter(Boolean);
  settings.workflowsUnset = initialWorkflows === null;

  function setMode(next: ChatMode): void {
    mode.value = next;
    try {
      localStorage.setItem('chatMode', next);
    } catch {
      /* ignore */
    }
  }

  function persistPersona(): void {
    try {
      localStorage.setItem('chatPersona', settings.persona || '');
    } catch {
      /* ignore */
    }
  }

  function persistWorkspace(): void {
    settings.workspace = normalizeWorkspaceId(settings.workspace);
    try {
      localStorage.setItem('chatWorkspace', settings.workspace);
    } catch {
      /* ignore */
    }
  }

  function persistWorkflows(): void {
    try {
      localStorage.setItem('chatWorkflows', JSON.stringify(settings.workflows || []));
      settings.workflowsUnset = false;
    } catch {
      /* ignore */
    }
  }

  function setLlmSelection({ factoryId, endpointKey }: LlmSelection = {}): void {
    settings.llmFactory = factoryId || '';
    settings.provider = endpointKey || '';
    try {
      localStorage.setItem('chatLlmFactory', settings.llmFactory);
      localStorage.setItem('chatProvider', settings.provider);
    } catch {
      /* ignore */
    }
  }

  /** 写回当前模式历史（每次 push 后调用） */
  function persistHistory(m: ChatMode = mode.value): void {
    saveChatHistory(m, histories[m] || []);
  }

  function clearHistory(m: ChatMode = mode.value): void {
    histories[m] = [];
    clearChatHistoryStorage(m);
    clearStoredChatScroll(m);
  }

  return {
    mode,
    settings,
    llmOptions,
    workspacePresets,
    histories,
    setMode,
    persistPersona,
    persistWorkspace,
    persistWorkflows,
    setLlmSelection,
    persistHistory,
    clearHistory,
  };
});

function normalizeMode(value: string | null): ChatMode {
  return value === 'event' || value === 'voice' || value === 'ai' ? value : 'ai';
}

function readWorkflows(): unknown[] | null {
  try {
    const raw = localStorage.getItem('chatWorkflows');
    // null = never set → ChatView applies preferred defaults once
    if (raw == null) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}