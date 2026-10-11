<script setup lang="ts">
/**
 * 字符串数组：芯片可点编辑；底部输入 + 添加/保存（cfg-tb-save 风格）
 */
import { computed, nextTick, ref } from 'vue';
import { NButton, NInput } from 'naive-ui';
import type { InputInst } from 'naive-ui';
import XrkIcon from '@/components/XrkIcon.vue';

const props = defineProps({
  modelValue: { type: [Array, String], default: () => [] },
  placeholder: { type: String, default: '输入内容' },
});

const emit = defineEmits(['update:modelValue']);
const draft = ref('');
/** @type {import('vue').Ref<number>} */
const editingIndex = ref(-1);
const inputRef = ref<InputInst | null>(null);

const tags = computed(() => {
  if (Array.isArray(props.modelValue)) {
    return props.modelValue.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return String(props.modelValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
});

const isEditing = computed(() => editingIndex.value >= 0);
const canSubmit = computed(() => Boolean(draft.value.trim()));

function commit(next: string[]) {
  emit('update:modelValue', next);
}

function resetDraft() {
  draft.value = '';
  editingIndex.value = -1;
}

async function focusInput() {
  await nextTick();
  inputRef.value?.focus?.();
}

function startEdit(i: number) {
  editingIndex.value = i;
  draft.value = tags.value[i] || '';
  void focusInput();
}

function removeAt(i: number, e?: Event) {
  e?.stopPropagation?.();
  e?.preventDefault?.();
  if (editingIndex.value === i) resetDraft();
  else if (editingIndex.value > i) editingIndex.value -= 1;
  commit(tags.value.filter((_, idx) => idx !== i));
}

function submit() {
  const t = draft.value.trim();
  if (!t) return;
  const list = [...tags.value];
  if (isEditing.value) {
    let i = editingIndex.value;
    const other = list.findIndex((x, idx) => idx !== i && x === t);
    if (other >= 0) {
      list.splice(other, 1);
      if (other < i) i -= 1;
    }
    list[i] = t;
    commit(list);
  } else if (!list.includes(t)) {
    commit([...list, t]);
  }
  resetDraft();
}

function onClear() {
  if (isEditing.value) resetDraft();
  else draft.value = '';
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
    return;
  }
  if (e.key === 'Escape' && isEditing.value) {
    e.preventDefault();
    resetDraft();
  }
}
</script>

<template>
  <div class="tags-ed">
    <div v-if="tags.length" class="tags-list" role="list">
      <button
        v-for="(t, i) in tags"
        :key="`${t}-${i}`"
        type="button"
        class="tags-chip"
        :class="{ editing: editingIndex === i }"
        role="listitem"
        :title="editingIndex === i ? '正在编辑' : '点击编辑'"
        @click="startEdit(i)"
      >
        <span class="tags-chip-text">{{ t }}</span>
        <span
          class="tags-chip-x"
          role="button"
          tabindex="0"
          title="删除"
          aria-label="删除"
          @click="removeAt(i, $event)"
          @keydown.enter.prevent="removeAt(i, $event)"
        >
          ×
        </span>
      </button>
    </div>
    <p v-else class="tags-empty">暂无项 · 填写后点添加；已有项点芯片可改</p>

    <div class="tags-add" :class="{ 'is-editing': isEditing }">
      <NInput
        ref="inputRef"
        v-model:value="draft"
        size="small"
        class="tags-add-input"
        :placeholder="isEditing ? '修改后点保存，Esc 取消' : placeholder"
        clearable
        @keydown="onKeydown"
        @clear="onClear"
      />
      <NButton
        v-if="isEditing"
        size="small"
        secondary
        class="cfg-tb-btn"
        aria-label="取消编辑"
        @click="resetDraft"
      >
        取消
      </NButton>
      <NButton
        size="small"
        type="primary"
        class="cfg-tb-btn cfg-tb-save"
        :disabled="!canSubmit"
        :aria-label="isEditing ? '保存' : '添加'"
        @click="submit"
      >
        <XrkIcon :name="isEditing ? 'check' : 'plus'" :size="14" />
        <span>{{ isEditing ? '保存' : '添加' }}</span>
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.tags-ed {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 96px;
  overflow-y: auto;
}
.tags-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin: 0;
  padding: 2px 4px 2px 8px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--yellow) 22%, var(--card));
  box-shadow: var(--shadow);
  color: var(--ink);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 800;
  line-height: 1.25;
  cursor: pointer;
  touch-action: manipulation;
  text-align: left;
}
.tags-chip:active {
  transform: translate(1px, 1px);
  box-shadow: none;
}
.tags-chip.editing {
  background: color-mix(in srgb, var(--pink) 28%, var(--card));
  outline: 2px solid var(--pink);
  outline-offset: 0;
}
.tags-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 12em;
}
.tags-chip-x {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1.5px solid transparent;
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
  color: var(--muted);
}
.tags-chip-x:hover,
.tags-chip-x:focus-visible {
  border-color: var(--ink);
  background: color-mix(in srgb, var(--red) 35%, var(--card));
  color: var(--ink);
  outline: none;
}
.tags-empty {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.35;
}
.tags-add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
}
.tags-add.is-editing {
  grid-template-columns: minmax(0, 1fr) auto auto;
}
.tags-add-input {
  min-width: 0;
}

@media (max-width: 480px) {
  .tags-chip {
    min-height: 28px;
  }
  .tags-chip-x {
    width: 24px;
    height: 24px;
  }
  .tags-add .cfg-tb-save {
    min-height: 32px;
  }
}
</style>
