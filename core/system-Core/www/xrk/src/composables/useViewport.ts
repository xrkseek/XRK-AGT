import { onMounted, onUnmounted, ref } from 'vue';

const MQ = '(max-width: 800px)';

/**
 * 桌面 / 手机断点（与 tokens 800px 一致）
 * @returns {{ isMobile: import('vue').Ref<boolean> }}
 */
export function useViewport() {
  const isMobile = ref(
    typeof window !== 'undefined' ? window.matchMedia(MQ).matches : false,
  );

  let mql: MediaQueryList | undefined;
  function onChange(e: MediaQueryListEvent): void {
    isMobile.value = e.matches;
  }

  onMounted(() => {
    mql = window.matchMedia(MQ);
    isMobile.value = mql.matches;
    mql.addEventListener('change', onChange);
  });

  onUnmounted(() => {
    mql?.removeEventListener('change', onChange);
  });

  return { isMobile };
}
