import { onUnmounted, ref } from 'vue';

const KEY = 'xrk.listPaneWidth';
const DEFAULT_W = 260;
const MIN_W = 180;
const MAX_W = 520;

/** 配置 / 对话 / API 左侧列表共用（模块级单例） */
const width = ref(read());

function clamp(n: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, Math.round(n)));
}

function read(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    if (Number.isFinite(n) && n > 0) return clamp(n);
  } catch {
    /* ignore */
  }
  return DEFAULT_W;
}

function persist() {
  try {
    localStorage.setItem(KEY, String(width.value));
  } catch {
    /* ignore */
  }
}

/**
 * 配置 / 对话 / API 左侧列表共用宽度（可拖拽，localStorage 持久化）
 * @returns {{ width: import('vue').Ref<number>, startResize: (e: PointerEvent) => void }}
 */
export function useListPaneWidth() {
  let dragging = false;
  let startX = 0;
  let startW = 0;

  function onMove(e: PointerEvent): void {
    if (!dragging) return;
    width.value = clamp(startW + (e.clientX - startX));
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    persist();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function startResize(e: PointerEvent): void {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = width.value;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  onUnmounted(onUp);

  return { width, startResize };
}
