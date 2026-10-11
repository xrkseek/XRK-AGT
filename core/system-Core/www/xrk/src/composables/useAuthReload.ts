import { watch } from 'vue';
import { useAuthStore } from '@/stores/auth';

/** API Key 写入后（keyEpoch++）立刻重拉，无需切页 */
export function useAuthReload(reload: () => unknown): void {
  const auth = useAuthStore();
  watch(
    () => auth.keyEpoch,
    () => {
      void reload();
    },
  );
}
