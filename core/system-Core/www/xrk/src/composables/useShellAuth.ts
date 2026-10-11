import { ref, watch } from 'vue';
import { useDialog } from 'naive-ui';
import { useAuthStore } from '@/stores/auth';

/** 顶栏 API Key：草稿 → 点保存 / 回车写入 store，并触发各页按 keyEpoch 重拉 */
export function useShellAuth() {
  const auth = useAuthStore();
  const dialog = useDialog();
  const keyDraft = ref(auth.apiKey);

  watch(
    () => auth.apiKey,
    (v) => {
      if (v !== keyDraft.value) keyDraft.value = v;
    },
  );

  function saveKey() {
    const next = String(keyDraft.value || '').trim();
    if (!next) {
      keyDraft.value = auth.apiKey;
      return false;
    }
    auth.setApiKey(next);
    return true;
  }

  function clearKey() {
    if (!auth.hasKey) {
      keyDraft.value = '';
      return;
    }
    dialog.warning({
      title: '清除 API Key',
      content: '确认清除已保存的 API Key？',
      positiveText: '清除',
      negativeText: '取消',
      onPositiveClick: () => {
        keyDraft.value = '';
        auth.setApiKey('');
      },
      onNegativeClick: () => {
        keyDraft.value = auth.apiKey;
      },
    });
  }

  function onKeyEnter() {
    if (!String(keyDraft.value || '').trim()) clearKey();
    else saveKey();
  }

  return { auth, keyDraft, saveKey, clearKey, onKeyEnter };
}
