<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PropType } from 'vue';
import XrkIcon from '@/components/XrkIcon.vue';

const props = defineProps({
  modelValue: { type: Array as PropType<File[]>, default: () => [] },
  multiple: { type: Boolean, default: true },
  accept: { type: String, default: '' },
  label: { type: String, default: '点击或拖放文件到此处' },
  hint: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const inputEl = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

const files = computed<File[]>(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

function formatSize(n: number) {
  const size = Number(n) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function setFiles(list: FileList | File[] | null | undefined) {
  const next = Array.from(list || []).filter(Boolean);
  emit('update:modelValue', props.multiple ? next : next.slice(0, 1));
}

function onPick(e: Event) {
  setFiles((e.target as HTMLInputElement | null)?.files);
  if (inputEl.value) inputEl.value.value = '';
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  setFiles(e.dataTransfer?.files);
}

function removeAt(i: number) {
  emit(
    'update:modelValue',
    files.value.filter((_, idx) => idx !== i),
  );
}

function clearAll() {
  emit('update:modelValue', []);
}
</script>

<template>
  <div class="drop-wrap">
    <div
      class="drop"
      :class="{ over: dragOver, has: files.length }"
      role="button"
      tabindex="0"
      :aria-label="label"
      @click="inputEl?.click()"
      @keydown.enter.prevent="inputEl?.click()"
      @keydown.space.prevent="inputEl?.click()"
      @dragenter.prevent="dragOver = true"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <XrkIcon name="upload" :size="28" />
      <p class="drop-lbl">{{ label }}</p>
      <p v-if="hint" class="drop-hint">{{ hint }}</p>
      <input
        ref="inputEl"
        type="file"
        class="hidden"
        :multiple="multiple"
        :accept="accept || undefined"
        @change="onPick"
      />
    </div>

    <div v-if="files.length" class="file-list">
      <div class="list-bar">
        <span>{{ files.length }} 个文件</span>
        <button type="button" class="link" @click="clearAll">清空</button>
      </div>
      <div v-for="(f, i) in files" :key="`${f.name}-${f.size}-${i}`" class="file-row">
        <div class="info">
          <strong class="name" :title="f.name">{{ f.name }}</strong>
          <span class="size mono">{{ formatSize(f.size) }}</span>
        </div>
        <button type="button" class="rm" :aria-label="`移除 ${f.name}`" @click="removeAt(i)">×</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drop-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 120px;
  padding: 16px 12px;
  border: 2px dashed color-mix(in srgb, var(--ink) 55%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--cyan) 10%, var(--card));
  color: var(--ink);
  text-align: center;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.drop:hover,
.drop.over {
  background: color-mix(in srgb, var(--cyan) 22%, var(--card));
  border-color: var(--ink);
  border-style: solid;
}
.drop.has {
  min-height: 88px;
  background: color-mix(in srgb, var(--yellow) 14%, var(--card));
}
.drop-lbl {
  margin: 0;
  font-size: var(--font-sm);
  font-weight: 800;
}
.drop-hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--muted);
}
.hidden {
  display: none;
}
.file-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1.5px solid var(--ink);
  border-radius: 8px;
  padding: 6px;
  background: var(--card);
}
.list-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--muted);
  padding: 0 2px 4px;
  border-bottom: 1px dashed color-mix(in srgb, var(--ink) 28%, transparent);
}
.link {
  border: none;
  background: transparent;
  color: var(--pink);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 800;
  cursor: pointer;
  padding: 0;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-radius: 6px;
}
.file-row:hover {
  background: color-mix(in srgb, var(--paper-2) 40%, transparent);
}
.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.name {
  font-size: var(--font-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  font-size: var(--font-xs);
  color: var(--muted);
}
.rm {
  width: 26px;
  height: 26px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--paper-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
</style>
