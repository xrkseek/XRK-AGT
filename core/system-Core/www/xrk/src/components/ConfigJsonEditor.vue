<script setup lang="ts">
/**
 * JSON 对象编辑：本地草稿 + 校验态，错误区固定高度防抖动
 */
import { ref, watch } from 'vue';
import { NButton, NInput } from 'naive-ui';

const props = defineProps({
  modelValue: { type: [Object, Array, String, Number, Boolean, null], default: null },
  rows: { type: Number, default: 0 },
});

const emit = defineEmits(['update:modelValue']);

const draft = ref('{}');
const error = ref('');

function stringify(v: unknown) {
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

watch(
  () => props.modelValue,
  (v) => {
    const next = stringify(v);
    // 避免父级回写打断正在编辑的非法草稿
    if (!error.value) draft.value = next;
  },
  { immediate: true, deep: true },
);

function onInput(text: string) {
  draft.value = text;
  try {
    const parsed = JSON.parse(text || 'null');
    error.value = '';
    emit('update:modelValue', parsed);
  } catch (err) {
    error.value = (err as { message?: string } | null)?.message || 'JSON 无法解析';
  }
}

function format() {
  try {
    const parsed = JSON.parse(draft.value || 'null');
    draft.value = JSON.stringify(parsed, null, 2);
    error.value = '';
    emit('update:modelValue', parsed);
  } catch (err) {
    error.value = (err as { message?: string } | null)?.message || 'JSON 无法解析';
  }
}
</script>

<template>
  <div class="json-editor">
    <div class="json-bar">
      <NButton size="tiny" secondary @click="format">格式化</NButton>
      <span class="status" :class="{ bad: !!error }">{{ error || '语法正确' }}</span>
    </div>
    <NInput
      :value="draft"
      type="textarea"
      size="small"
      class="mono"
      :rows="rows || 6"
      :status="error ? 'error' : undefined"
      @update:value="onInput"
    />
  </div>
</template>

<style scoped>
.json-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.json-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}
.status {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--muted);
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status.bad {
  color: var(--red);
}
.json-editor :deep(textarea) {
  font-family: var(--mono);
  min-height: 96px;
  field-sizing: fixed;
}
</style>
