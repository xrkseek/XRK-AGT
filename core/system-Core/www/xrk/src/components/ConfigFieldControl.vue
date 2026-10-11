<script setup lang="ts">
/**
 * 统一配置字段控件（顶层表单 / 数组项 / 嵌套子表共用）
 */
import { computed } from 'vue';
import { NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui';
import { normalizeOptions, resolveFieldControl } from '@/config/flat';
import ConfigTagsEditor from '@/components/ConfigTagsEditor.vue';
import ConfigKvEditor from '@/components/ConfigKvEditor.vue';
import ConfigJsonEditor from '@/components/ConfigJsonEditor.vue';

const props = defineProps({
  schema: { type: Object, default: () => ({}) },
  modelValue: { type: null, default: undefined },
  inputId: { type: String, default: '' },
  /** 覆盖 resolveFieldControl（少用） */
  control: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

const ctrl = computed(() => props.control || resolveFieldControl(props.schema));

const selectOptions = computed(() =>
  normalizeOptions(props.schema?.options || props.schema?.enum || props.schema?.choices)
    .filter((o) => o.value !== '' && o.value != null)
    .map((o) => ({ label: String(o.label), value: o.value as string | number })),
);

function set(v: unknown) {
  emit('update:modelValue', v);
}

const boolValue = computed(() => Boolean(props.modelValue));

/** MultiSelect：始终数组；可清空 */
const multiValue = computed(() => {
  if (Array.isArray(props.modelValue)) return props.modelValue;
  if (props.modelValue == null || props.modelValue === '') return [];
  return [props.modelValue];
});
</script>

<template>
  <div class="cfg-ctrl" :data-ctrl="ctrl">
    <NSwitch
      v-if="ctrl === 'switch'"
      :id="inputId || undefined"
      :value="boolValue"
      size="small"
      @update:value="set"
    />
    <NSelect
      v-else-if="ctrl === 'select'"
      :id="inputId || undefined"
      :value="modelValue === '' ? null : modelValue"
      size="small"
      :options="selectOptions"
      :placeholder="schema.placeholder || '请选择'"
      clearable
      filterable
      @update:value="(v) => set(v == null ? '' : v)"
    />
    <NSelect
      v-else-if="ctrl === 'multiselect'"
      :id="inputId || undefined"
      :value="multiValue"
      size="small"
      multiple
      :options="selectOptions"
      :placeholder="schema.placeholder || '可多选，可清空'"
      clearable
      filterable
      max-tag-count="responsive"
      @update:value="(v) => set(Array.isArray(v) ? v : [])"
    />
    <NInputNumber
      v-else-if="ctrl === 'number'"
      :id="inputId || undefined"
      :value="modelValue"
      size="small"
      button-placement="both"
      :min="schema.min"
      :max="schema.max"
      :step="schema.step || 1"
      class="num"
      @update:value="set"
    />
    <NInput
      v-else-if="ctrl === 'password'"
      :id="inputId || undefined"
      :value="modelValue == null ? '' : String(modelValue)"
      type="password"
      show-password-on="click"
      size="small"
      :placeholder="schema.placeholder"
      @update:value="set"
    />
    <NInput
      v-else-if="ctrl === 'textarea'"
      :id="inputId || undefined"
      :value="modelValue == null ? '' : String(modelValue)"
      type="textarea"
      size="small"
      :rows="3"
      :placeholder="schema.placeholder"
      @update:value="set"
    />
    <ConfigTagsEditor
      v-else-if="ctrl === 'tags'"
      :model-value="modelValue"
      :placeholder="schema.placeholder || '输入后点添加'"
      @update:model-value="set"
    />
    <ConfigKvEditor
      v-else-if="ctrl === 'kv'"
      :model-value="modelValue && typeof modelValue === 'object' && !Array.isArray(modelValue) ? modelValue : {}"
      @update:model-value="set"
    />
    <ConfigJsonEditor
      v-else-if="ctrl === 'json'"
      :model-value="modelValue"
      @update:model-value="set"
    />
    <NInput
      v-else
      :id="inputId || undefined"
      :value="modelValue == null ? '' : String(modelValue)"
      size="small"
      :placeholder="schema.placeholder"
      @update:value="set"
    />
  </div>
</template>

<style scoped>
.cfg-ctrl {
  width: 100%;
  min-height: 28px;
  display: flex;
  align-items: center;
}
.cfg-ctrl[data-ctrl='textarea'],
.cfg-ctrl[data-ctrl='array'],
.cfg-ctrl[data-ctrl='json'],
.cfg-ctrl[data-ctrl='kv'],
.cfg-ctrl[data-ctrl='nested'],
.cfg-ctrl[data-ctrl='keyed'],
.cfg-ctrl[data-ctrl='multiselect'] {
  align-items: stretch;
}
.cfg-ctrl :deep(.num) {
  width: 100%;
}
.cfg-ctrl :deep(.n-input),
.cfg-ctrl :deep(.n-base-selection),
.cfg-ctrl :deep(.n-input-number) {
  width: 100%;
}
.cfg-ctrl :deep(textarea.n-input__textarea-el) {
  resize: vertical;
  min-height: 52px;
}
</style>
