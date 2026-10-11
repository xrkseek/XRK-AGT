<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue';
import { sizeClass, toneClass } from '@/home/metrics';
import type { SizeClass, ToneClass } from '@/home/metrics';
import XrkIcon from '@/components/XrkIcon.vue';

/** HomeTagCloud 入参 chip（与 HomeView CloudChip 对齐） */
interface CloudChip {
  label: string;
  seed?: string;
  badge?: string;
  disabled?: boolean;
  popoverTitle?: string;
  popoverKey?: string;
  desc?: string;
  facts?: Array<{ label: string; value: string }>;
}

interface CloudChipView extends CloudChip {
  size: SizeClass;
  tone: ToneClass;
  tip: string;
  stagger: number;
}

const props = defineProps({
  items: { type: Array as PropType<CloudChip[]>, default: () => [] },
  tipPrefix: { type: String, default: 'tip' },
});

const root = ref<HTMLElement | null>(null);
const activeTip = ref<string | null>(null);

function tipId(item: CloudChip, i: number) {
  const base = String(item.seed ?? item.label ?? 'x')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  return `${props.tipPrefix}-${i}-${base || 'n'}`;
}

const chips = computed<CloudChipView[]>(() =>
  props.items.map((item: CloudChip, i: number): CloudChipView => ({
    ...item,
    size: sizeClass(item.seed ?? item.label ?? i),
    tone: toneClass(item.seed ?? item.label ?? i),
    tip: tipId(item, i),
    stagger: i,
  })),
);

const activeChip = computed(
  () => chips.value.find((c) => c.tip === activeTip.value) || null,
);

function closeDetail() {
  activeTip.value = null;
}

function onPeerClose(e: Event) {
  if ((e as CustomEvent | undefined)?.detail !== props.tipPrefix) closeDetail();
}

function toggleChip(tip: string) {
  if (activeTip.value === tip) {
    closeDetail();
    return;
  }
  document.dispatchEvent(
    new CustomEvent('xrk-home-tag-close', { detail: props.tipPrefix }),
  );
  activeTip.value = tip;
}

function onDocPointer(e: Event) {
  if (!activeTip.value) return;
  const t = e.target as Node | null;
  if (!t) return;
  if (root.value?.contains(t)) return;
  if (t instanceof Element && t.closest('[data-tag-detail]')) return;
  closeDetail();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDetail();
}

watch(
  () => props.items,
  () => {
    if (activeTip.value && !chips.value.some((c) => c.tip === activeTip.value)) {
      closeDetail();
    }
  },
);

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true);
  document.addEventListener('keydown', onKey);
  document.addEventListener('xrk-home-tag-close', onPeerClose);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('xrk-home-tag-close', onPeerClose);
});
</script>

<template>
  <!-- Teleport 放在 flex 容器外，避免占位节点干扰换行 -->
  <Teleport to="body">
    <div
      v-if="activeChip"
      class="xrk-tag-detail-layer"
      data-tag-detail
      role="dialog"
      aria-modal="true"
      :aria-label="activeChip.popoverTitle || activeChip.label"
    >
      <div class="xrk-tag-detail-scrim" @click="closeDetail" />
      <div class="xrk-tag-detail">
        <div class="xrk-tag-detail-head">
          <div class="xrk-tag-detail-titles">
            <strong class="xrk-tag-detail-title">{{ activeChip.popoverTitle || activeChip.label }}</strong>
            <span v-if="activeChip.popoverKey" class="xrk-tag-detail-key mono">{{ activeChip.popoverKey }}</span>
          </div>
          <button
            type="button"
            class="xrk-tag-detail-close"
            aria-label="关闭详情"
            title="关闭"
            @click="closeDetail"
          >
            <XrkIcon name="close" :size="14" />
          </button>
        </div>
        <div class="xrk-tag-detail-body ink-scroll">
          <p class="xrk-tag-detail-desc">{{ activeChip.desc || '暂无描述' }}</p>
          <ul v-if="activeChip.facts?.length" class="xrk-tag-detail-facts">
            <li v-for="(f, fi) in activeChip.facts" :key="fi">
              <span>{{ f.label }}</span>
              <em>{{ f.value }}</em>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>

  <div ref="root" class="tag-cloud" role="list">
    <div
      v-for="chip in chips"
      :key="chip.tip"
      class="chip"
      :class="[
        `size-${chip.size}`,
        `tone-${chip.tone}`,
        { disabled: chip.disabled, active: chip.tip === activeTip },
      ]"
      :style="{ '--stagger': chip.stagger }"
      role="listitem"
    >
      <button
        type="button"
        class="chip-btn"
        :aria-expanded="chip.tip === activeTip ? 'true' : 'false'"
        :title="chip.popoverTitle || chip.label"
        @click="toggleChip(chip.tip)"
      >
        <span class="chip-label">{{ chip.label }}</span>
        <span v-if="chip.badge" class="chip-badge" aria-hidden="true">{{ chip.badge }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: flex-start;
  justify-content: flex-start;
  gap: 4px 5px;
  padding: 2px 0;
  width: 100%;
  min-width: 0;
}
.chip {
  position: relative;
  flex: 0 0 auto;
  max-width: 100%;
  animation: chip-in 0.36s cubic-bezier(0.22, 1, 0.36, 1) backwards;
  animation-delay: calc(var(--stagger, 0) * 22ms);
}
@keyframes chip-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chip {
    animation: none;
  }
}
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin: 0;
  max-width: 160px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  box-shadow: var(--shadow);
  transition: transform 100ms ease, box-shadow 100ms ease;
  cursor: pointer;
  touch-action: manipulation;
}
.size-sm .chip-btn {
  padding: 2px 6px;
  font-size: var(--font-xs);
}
.size-md .chip-btn {
  padding: 2px 7px;
  font-size: 11px;
}
.size-lg .chip-btn {
  padding: 3px 8px;
  font-size: 11.5px;
}
.tone-primary .chip-btn {
  background: color-mix(in srgb, var(--cyan) 28%, var(--card));
}
.tone-success .chip-btn {
  background: color-mix(in srgb, var(--green) 28%, var(--card));
}
.tone-warning .chip-btn {
  background: color-mix(in srgb, var(--yellow) 40%, var(--card));
}
.tone-info .chip-btn {
  background: color-mix(in srgb, var(--pink) 22%, var(--card));
}
.disabled .chip-btn {
  opacity: 0.62;
  filter: grayscale(0.12);
}
.chip.active .chip-btn,
.chip-btn:hover,
.chip-btn:focus-visible {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 var(--ink);
}
.chip.active .chip-btn {
  outline: 2px solid var(--ink);
  outline-offset: 1px;
}
.chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-badge {
  flex-shrink: 0;
  font-size: var(--font-xs);
  font-weight: 800;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--ink);
  background: var(--muted);
  color: var(--card);
}
</style>

<!-- Teleport 到 body，样式不能 scoped 依赖父级 -->
<style>
.xrk-tag-detail-layer {
  position: fixed;
  inset: 0;
  z-index: 80;
  pointer-events: none;
}
.xrk-tag-detail-scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, #000 36%, transparent);
  pointer-events: auto;
}
.xrk-tag-detail {
  pointer-events: auto;
  position: absolute;
  left: 50%;
  top: max(12px, env(safe-area-inset-top));
  transform: translateX(-50%);
  width: min(420px, calc(100vw - 24px));
  max-height: min(70vh, 420px);
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 12px 14px;
  border: 2px solid var(--ink);
  border-radius: 12px;
  background: var(--card);
  box-shadow: 4px 4px 0 var(--ink);
  color: var(--ink);
}
.xrk-tag-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  margin-bottom: 8px;
}
.xrk-tag-detail-titles {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.xrk-tag-detail-title {
  font-size: 14px;
  font-weight: 800;
  line-height: 1.35;
  word-break: break-word;
}
.xrk-tag-detail-key {
  font-size: 11px;
  color: var(--muted);
  word-break: break-all;
}
.xrk-tag-detail-close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--pink) 22%, var(--card));
  box-shadow: var(--shadow);
  cursor: pointer;
  touch-action: manipulation;
  color: var(--ink);
}
.xrk-tag-detail-close:active {
  transform: translate(1px, 1px);
  box-shadow: none;
}
.xrk-tag-detail-body {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.xrk-tag-detail-desc {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.xrk-tag-detail-facts {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0;
}
.xrk-tag-detail-facts li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  padding: 6px 0;
  border-top: 1px dashed color-mix(in srgb, var(--ink) 22%, transparent);
}
.xrk-tag-detail-facts li:first-child {
  border-top: none;
  padding-top: 0;
}
.xrk-tag-detail-facts em {
  font-style: normal;
  font-weight: 700;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  text-align: right;
  word-break: break-word;
}
@media (min-width: 801px) {
  .xrk-tag-detail {
    top: max(16px, calc(var(--topbar-h, 48px) + 16px));
  }
}
</style>
