import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { normalizeWorkspaceId } from '@/chat/llm-settings';
import {
  clearChatHistoryStorage,
  loadChatHistory,
  saveChatHistory,
} from '@/chat/history';
import { clearStoredChatScroll } from '@/chat/scroll';

function readWorkflows() {
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

const initialWorkflows = readWorkflows();

export const useChatStore = defineStore('chat', () => {
  const mode = ref(localStorage.getItem('chatMode') || 'ai');
  const settings = reactive({
    persona: localStorage.getItem('chatPersona') || '',
    provider: localStorage.getItem('chatProvider') || '',
    llmFactory: localStorage.getItem('chatLlmFactory') || '',
    workspace: normalizeWorkspaceId(localStorage.getItem('chatWorkspace')),
    workflows: initialWorkflows ?? [],
    /** true when localStorage never had chatWorkflows (apply preferred MCP defaults once) */
    workflowsUnset: initialWorkflows === null,
  });
  const llmOptions = ref(null);
  const workspacePresets = ref([{ id: 'default', label: '默认工作区' }]);

  /** 与原版三键兼容；启动时从 localStorage 恢复 */
  const histories = reactive({
    ai: loadChatHistory('ai'),
    event: loadChatHistory('event'),
    voice: loadChatHistory('voice'),
  });

  function setMode(next) {
    mode.value = next;
    try {
      localStorage.setItem('chatMode', next);
    } catch {
      /* ignore */
    }
  }

  function persistPersona() {
    try {
      localStorage.setItem('chatPersona', settings.persona || '');
    } catch {
      /* ignore */
    }
  }

  function persistWorkspace() {
    settings.workspace = normalizeWorkspaceId(settings.workspace);
    try {
      localStorage.setItem('chatWorkspace', settings.workspace);
    } catch {
      /* ignore */
    }
  }

  function persistWorkflows() {
    try {
      localStorage.setItem('chatWorkflows', JSON.stringify(settings.workflows || []));
      settings.workflowsUnset = false;
    } catch {
      /* ignore */
    }
  }

  function setLlmSelection({ factoryId, endpointKey }) {
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
  function persistHistory(m = mode.value) {
    saveChatHistory(m, histories[m] || []);
  }

  function clearHistory(m = mode.value) {
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
