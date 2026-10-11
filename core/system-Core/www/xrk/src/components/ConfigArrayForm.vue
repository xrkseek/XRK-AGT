<script setup lang="ts">
/**
 * 数组<object> 工厂式编辑（LLM providers 等）
 * UI 壳与 ConfigKeyedMapForm 共用 config-chrome.css
 */
import { computed, ref, watch } from 'vue';
import { NButton } from 'naive-ui';
import {
  buildDefaultsFromFields,
  getNestedValue,
  isConfigEntryFieldFull,
  resolveFieldControl,
  setNestedValue,
} from '@/config/flat';
import type { FieldControl, SchemaNode } from '@/config/flat';
import type { LoosePayload } from '@/types';
import {
  getProviderEntrySummary,
  groupProviderSchemaFields,
  isLlmProvidersArray,
} from '@/config/llm-provider-ui';
import { useConfirmDialog } from '@/composables/useConfirmDialog';
import { randomId } from '@/utils/http';
import ConfigFieldControl from '@/components/ConfigFieldControl.vue';
import ConfigJsonEditor from '@/components/ConfigJsonEditor.vue';
import XrkIcon from '@/components/XrkIcon.vue';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  path: { type: String, default: '' },
  label: { type: String, default: '条目' },
  itemFields: { type: Object, default: () => ({}) },
  dense: { type: Boolean, default: false },
});

const emit = defineEmits<{ (e: 'update:modelValue', value: LoosePayload[]): void }>();
const { confirm } = useConfirmDialog();

const items = computed<LoosePayload[]>(() =>
  Array.isArray(props.modelValue) ? (props.modelValue as LoosePayload[]) : [],
);
const isProviders = computed(() => isLlmProvidersArray(props.path));
const hasSchema = computed(() => Object.keys(props.itemFields || {}).length > 0);
const rootEl = ref<HTMLElement | null>(null);
const rowKeys = ref<string[]>([]);

interface FormSection {
  id: string;
  label: string;
  collapsible?: boolean;
  entries: Array<[string, SchemaNode]>;
}

const sectionsForItem = computed<FormSection[]>(() => {
  if (!hasSchema.value) return [];
  if (isProviders.value) return groupProviderSchemaFields(props.itemFields) as FormSection[];
  return [
    {
      id: 'all',
      label: '',
      collapsible: false,
      entries: Object.entries(props.itemFields) as Array<[string, SchemaNode]>,
    },
  ];
});

watch(
  () => items.value.length,
  (len) => {
    const next = rowKeys.value.slice(0, len);
    while (next.length < len) next.push(randomId());
    rowKeys.value = next;
  },
  { immediate: true },
);

function fieldControl(schema: SchemaNode): FieldControl {
  return resolveFieldControl(schema);
}

function isFull(key: string, schema: SchemaNode): boolean {
  return isConfigEntryFieldFull(key, schema);
}

function readItem(item: unknown, relPath: string): unknown {
  return getNestedValue((item || {}) as LoosePayload, relPath);
}

function patchItem(index: number, relPath: string, value: unknown): void {
  emit(
    'update:modelValue',
    items.value.map((it, i) => {
      if (i !== index) return it;
      if (!relPath) return (value && typeof value === 'object' ? value : {}) as LoosePayload;
      return setNestedValue(it || {}, relPath, value);
    }),
  );
}

function addItem() {
  rowKeys.value = [...rowKeys.value, randomId()];
  emit('update:modelValue', [
    ...items.value,
    hasSchema.value ? buildDefaultsFromFields(props.itemFields) : {},
  ]);
}

async function removeItem(i: number): Promise<void> {
  const title = summary(items.value[i], i);
  const ok = await confirm({
    title: `删除${props.label || '条目'}`,
    content: `确认删除「${title}」？未保存前可点重载撤销。`,
    positiveText: '删除',
    negativeText: '取消',
  });
  if (!ok) return;
  const next = [...items.value];
  next.splice(i, 1);
  const keys = [...rowKeys.value];
  keys.splice(i, 1);
  rowKeys.value = keys;
  emit('update:modelValue', next);
}

function moveItem(i: number, delta: number): void {
  const next = [...items.value];
  const j = i + delta;
  if (j < 0 || j >= next.length) return;
  [next[i], next[j]] = [next[j], next[i]];
  const keys = [...rowKeys.value];
  [keys[i], keys[j]] = [keys[j], keys[i]];
  rowKeys.value = keys;
  emit('update:modelValue', next);
}

function summary(item: LoosePayload, index: number): string {
  if (isProviders.value) return getProviderEntrySummary(item) || `${props.label} #${index + 1}`;
  return `${props.label} #${index + 1}`;
}

/** nested 子字段表：模板里 Object.entries 会退化成 unknown，这里收口一次 */
function nestedEntries(schema: SchemaNode): Array<[string, SchemaNode]> {
  return Object.entries(schema.fields || {}) as Array<[string, SchemaNode]>;
}

function setAllOpen(open: boolean): void {
  rootEl.value?.querySelectorAll<HTMLDetailsElement>('details.card').forEach((el) => {
    el.open = open;
  });
}
</script>

<template>
  <div ref="rootEl" class="cfg-entry-list array-form" :class="{ dense, providers: isProviders }">
    <div class="bar">
      <span class="count">{{ items.length }} 项</span>
      <div class="cfg-tb-tools">
        <div v-if="items.length > 1" class="cfg-tb-group" role="group" aria-label="折叠">
          <NButton size="tiny" quaternary class="cfg-tb-btn" @click="setAllOpen(false)">全部折叠</NButton>
          <NButton size="tiny" quaternary class="cfg-tb-btn" @click="setAllOpen(true)">全部展开</NButton>
        </div>
        <NButton size="small" type="primary" class="cfg-tb-btn cfg-tb-save add-main" @click="addItem">
          <XrkIcon name="plus" :size="14" />
          <span>新增</span>
        </NButton>
      </div>
    </div>

    <button v-if="!items.length" type="button" class="empty-add" @click="addItem">
      <XrkIcon name="plus" :size="16" />
      <span>新增{{ label || '条目' }}</span>
    </button>

    <details
      v-for="(item, i) in items"
      :key="rowKeys[i] || i"
      class="card"
      v-bind="isProviders ? {} : { open: true }"
    >
      <summary class="card-head">
        <span class="card-title">{{ summary(item, i) }}</span>
        <div class="card-acts" @click.stop>
          <NButton
            size="tiny"
            quaternary
            class="ico-only"
            :disabled="i === 0"
            title="上移"
            aria-label="上移"
            @click="moveItem(i, -1)"
          >
            <XrkIcon name="up" :size="14" />
          </NButton>
          <NButton
            size="tiny"
            quaternary
            class="ico-only"
            :disabled="i >= items.length - 1"
            title="下移"
            aria-label="下移"
            @click="moveItem(i, 1)"
          >
            <XrkIcon name="down" :size="14" />
          </NButton>
          <NButton
            size="tiny"
            tertiary
            type="error"
            class="ico-btn"
            title="删除"
            @click="removeItem(i)"
          >
            <XrkIcon name="trash" :size="13" />
            <span>删除</span>
          </NButton>
        </div>
      </summary>

      <div class="card-body">
        <template v-if="hasSchema">
          <component
            :is="sec.collapsible ? 'details' : 'section'"
            v-for="sec in sectionsForItem"
            :key="sec.id"
            class="section"
            v-bind="sec.collapsible && !isProviders ? { open: true } : {}"
          >
            <summary v-if="sec.collapsible" class="section-head">{{ sec.label }}</summary>
            <header v-else-if="sec.label" class="section-head static">{{ sec.label }}</header>

            <div class="field-grid">
              <template v-for="[key, schema] in sec.entries" :key="key">
                <div v-if="fieldControl(schema) === 'nested'" class="field full nested">
                  <div class="nested-title">{{ schema.label || key }}</div>
                  <p v-if="schema.description" class="desc" :title="schema.description">
                    {{ schema.description }}
                  </p>
                  <div class="field-grid">
                    <div
                      v-for="[nk, ns] in nestedEntries(schema)"
                      :key="nk"
                      class="field"
                      :class="{ full: isFull(nk, ns) }"
                    >
                      <label :title="ns.description || nk">{{ ns.label || nk }}</label>
                      <p
                        v-if="ns.description"
                        class="desc"
                        :class="{ compact: !isFull(nk, ns) }"
                        :title="ns.description"
                      >
                        {{ ns.description }}
                      </p>
                      <ConfigFieldControl
                        :schema="ns"
                        :model-value="readItem(item, `${key}.${nk}`)"
                        @update:model-value="(v) => patchItem(i, `${key}.${nk}`, v)"
                      />
                    </div>
                  </div>
                </div>

                <div
                  v-else
                  class="field"
                  :class="{ full: isFull(key, schema) }"
                >
                  <label :title="schema.description || key">{{ schema.label || key }}</label>
                  <p
                    v-if="schema.description"
                    class="desc"
                    :class="{ compact: !isFull(key, schema) }"
                    :title="schema.description"
                  >
                    {{ schema.description }}
                  </p>
                  <ConfigFieldControl
                    :schema="schema"
                    :model-value="readItem(item, key)"
                    @update:model-value="(v) => patchItem(i, key, v)"
                  />
                </div>
              </template>
            </div>
          </component>
        </template>
        <ConfigJsonEditor
          v-else
          :model-value="item && typeof item === 'object' ? item : {}"
          :rows="6"
          @update:model-value="(v) => patchItem(i, '', v && typeof v === 'object' ? v : {})"
        />
      </div>
    </details>
  </div>
</template>
