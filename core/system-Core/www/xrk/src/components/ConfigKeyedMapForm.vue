<script setup lang="ts">
/**
 * 动态键对象（map / keyedObject）
 * UI 壳与 ConfigArrayForm 共用 config-chrome.css
 */
import { computed, ref, watch } from 'vue';
import { NButton, NInput, useMessage } from 'naive-ui';
import {
  buildDefaultsFromFields,
  getNestedValue,
  inferFieldsFromExample,
  isConfigEntryFieldFull,
  resolveFieldControl,
  setNestedValue,
} from '@/config/flat';
import type { FieldControl, SchemaFieldMap, SchemaNode } from '@/config/flat';
import type { LoosePayload } from '@/types';
import { useConfirmDialog } from '@/composables/useConfirmDialog';
import { deepClone, randomId } from '@/utils/http';
import ConfigFieldControl from '@/components/ConfigFieldControl.vue';
import ConfigJsonEditor from '@/components/ConfigJsonEditor.vue';
import XrkIcon from '@/components/XrkIcon.vue';

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  label: { type: String, default: '条目' },
  itemFields: { type: Object, default: () => ({}) },
  example: { type: [Object, Array, String, Number, Boolean, null], default: null },
  keyLabel: { type: String, default: '键' },
  keyPlaceholder: { type: String, default: '输入键名' },
  dense: { type: Boolean, default: false },
});

const emit = defineEmits<{ (e: 'update:modelValue', value: LoosePayload): void }>();
const message = useMessage();
const { confirm } = useConfirmDialog();

const viewMode = ref('form');
const draftKey = ref('');
const rowKeys = ref<string[]>([]);
const entryOrder = ref<string[]>([]);
const rootEl = ref<HTMLElement | null>(null);

const resolvedFields = computed<SchemaFieldMap>(() => {
  const fromProp = props.itemFields && typeof props.itemFields === 'object' ? props.itemFields : {};
  if (Object.keys(fromProp).length) return fromProp as SchemaFieldMap;
  return inferFieldsFromExample(props.example) || inferFieldsFromExample(props.modelValue) || {};
});

const hasSchema = computed(() => Object.keys(resolvedFields.value).length > 0);

type EntryRow = { key: string; value: unknown };

const entries = computed<EntryRow[]>(() => {
  const obj: LoosePayload =
    props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
      ? (props.modelValue as LoosePayload)
      : {};
  const keys = entryOrder.value.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys.map((key) => ({ key, value: obj[key] }));
});

watch(
  () => props.modelValue,
  (v: LoosePayload) => {
    const obj: LoosePayload = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    const keys = Object.keys(obj);
    const nextOrder = entryOrder.value.filter((k) => keys.includes(k));
    for (const k of keys) {
      if (!nextOrder.includes(k)) nextOrder.push(k);
    }
    entryOrder.value = nextOrder;
    while (rowKeys.value.length < nextOrder.length) rowKeys.value.push(randomId());
    rowKeys.value = rowKeys.value.slice(0, nextOrder.length);
  },
  { immediate: true, deep: true },
);

function fieldControl(schema: SchemaNode): FieldControl {
  return resolveFieldControl(schema);
}

function isFull(key: string, schema: SchemaNode): boolean {
  return isConfigEntryFieldFull(key, schema);
}

function emitObj(next: LoosePayload): void {
  emit('update:modelValue', next);
}

function commitEntries(list: EntryRow[]): void {
  const out: LoosePayload = {};
  for (const row of list) {
    const k = String(row.key ?? '').trim();
    if (!k) continue;
    out[k] =
      row.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? row.value
        : row.value ?? {};
  }
  entryOrder.value = Object.keys(out);
  emitObj(out);
}

function renameKey(i: number, nextKey: string): void {
  const list = entries.value.map((e) => ({ ...e, value: deepClone(e.value) }));
  list[i] = { ...list[i], key: nextKey };
  commitEntries(list);
}

function patchValue(i: number, relPath: string, value: unknown): void {
  const list = entries.value.map((e) => ({ ...e, value: deepClone(e.value) }));
  const cur = list[i].value && typeof list[i].value === 'object' ? (list[i].value as LoosePayload) : {};
  list[i] = {
    ...list[i],
    value: relPath ? setNestedValue(cur, relPath, value) : value,
  };
  commitEntries(list);
}

function readValue(item: unknown, relPath: string): unknown {
  return getNestedValue((item || {}) as LoosePayload, relPath);
}

function addEntry() {
  const key = String(draftKey.value || '').trim();
  if (!key) {
    message.warning(`请先填写${props.keyLabel || '键名'}`);
    return;
  }
  const obj =
    props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
      ? { ...props.modelValue }
      : {};
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    message.warning(`${props.keyLabel || '键'}「${key}」已存在`);
    return;
  }
  obj[key] = hasSchema.value ? buildDefaultsFromFields(resolvedFields.value) : {};
  draftKey.value = '';
  rowKeys.value = [...rowKeys.value, randomId()];
  entryOrder.value = [...entryOrder.value, key];
  emitObj(obj);
}

async function removeEntry(i: number): Promise<void> {
  const key = entries.value[i]?.key;
  if (!key) return;
  const ok = await confirm({
    title: `删除${props.keyLabel || '条目'}`,
    content: `确认删除「${key}」？未保存前可点重载撤销。`,
    positiveText: '删除',
    negativeText: '取消',
  });
  if (!ok) return;
  const obj = { ...(props.modelValue || {}) };
  delete obj[key];
  const keys = [...rowKeys.value];
  keys.splice(i, 1);
  rowKeys.value = keys;
  entryOrder.value = entryOrder.value.filter((k) => k !== key);
  emitObj(obj);
}

async function applyExample() {
  const ex = props.example;
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return;
  if (Object.keys(props.modelValue || {}).length) {
    const ok = await confirm({
      title: '填入示例',
      content: '将用示例覆盖当前内容，继续？',
      positiveText: '覆盖',
      negativeText: '取消',
    });
    if (!ok) return;
  }
  emitObj(deepClone(ex));
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
  <div ref="rootEl" class="cfg-entry-list keyed-form" :class="{ dense }">
    <div class="bar">
      <span class="count">{{ entries.length }} 项</span>
      <div class="cfg-tb-tools">
        <div class="cfg-tb-group" role="group" aria-label="编辑模式">
          <NButton
            size="tiny"
            class="cfg-tb-btn"
            :type="viewMode === 'form' ? 'primary' : 'default'"
            :quaternary="viewMode !== 'form'"
            @click="viewMode = 'form'"
          >
            表单
          </NButton>
          <NButton
            size="tiny"
            class="cfg-tb-btn"
            :type="viewMode === 'json' ? 'primary' : 'default'"
            :quaternary="viewMode !== 'json'"
            @click="viewMode = 'json'"
          >
            JSON
          </NButton>
        </div>
        <div v-if="entries.length > 1 && viewMode === 'form'" class="cfg-tb-group" role="group" aria-label="折叠">
          <NButton size="tiny" quaternary class="cfg-tb-btn" @click="setAllOpen(false)">全部折叠</NButton>
          <NButton size="tiny" quaternary class="cfg-tb-btn" @click="setAllOpen(true)">全部展开</NButton>
        </div>
        <NButton
          v-if="example && typeof example === 'object' && !Array.isArray(example)"
          size="tiny"
          quaternary
          class="cfg-tb-btn"
          @click="applyExample"
        >
          填入示例
        </NButton>
      </div>
    </div>

    <ConfigJsonEditor
      v-if="viewMode === 'json'"
      :model-value="modelValue && typeof modelValue === 'object' ? modelValue : {}"
      @update:model-value="(v) => emitObj(v && typeof v === 'object' && !Array.isArray(v) ? v : {})"
    />

    <template v-else>
      <div class="add-row">
        <NInput
          v-model:value="draftKey"
          size="small"
          class="add-key"
          :placeholder="keyPlaceholder || `填写${keyLabel || '键名'}`"
          @keyup.enter="addEntry"
        />
        <NButton size="small" type="primary" class="cfg-tb-btn cfg-tb-save" @click="addEntry">
          <XrkIcon name="plus" :size="14" />
          <span>添加</span>
        </NButton>
      </div>

      <p v-if="!entries.length" class="empty">
        先填{{ keyLabel || '键名' }}，再点右侧「添加」
        <template v-if="hasSchema">；添加后按字段编辑</template>
        <template v-else>；无字段模板时可切 JSON</template>
      </p>

      <details v-for="(row, i) in entries" :key="rowKeys[i] || row.key" class="card" open>
        <summary class="card-head">
          <span class="card-title">{{ row.key || `(未命名 #${i + 1})` }}</span>
          <div class="card-acts" @click.stop>
            <NButton
              size="tiny"
              tertiary
              type="error"
              class="ico-btn"
              title="删除"
              @click.prevent="removeEntry(i)"
            >
              <XrkIcon name="trash" :size="13" />
              <span>删除</span>
            </NButton>
          </div>
        </summary>
        <div class="card-body">
          <div class="key-edit">
            <label>{{ keyLabel }}</label>
            <NInput
              :value="row.key"
              size="small"
              :placeholder="keyPlaceholder"
              @update:value="(v) => renameKey(i, v)"
            />
          </div>

          <div v-if="hasSchema" class="field-grid">
            <template v-for="[fk, schema] in Object.entries(resolvedFields)" :key="fk">
              <div v-if="fieldControl(schema) === 'nested'" class="field full nested">
                <div class="nested-title">{{ schema.label || fk }}</div>
                <div class="field-grid">
                  <div
                    v-for="[nk, ns] in nestedEntries(schema)"
                    :key="nk"
                    class="field"
                    :class="{ full: isFull(nk, ns) }"
                  >
                    <label :title="ns.description || nk">{{ ns.label || nk }}</label>
                    <ConfigFieldControl
                      :schema="ns"
                      :model-value="readValue(row.value, `${fk}.${nk}`)"
                      @update:model-value="(v) => patchValue(i, `${fk}.${nk}`, v)"
                    />
                  </div>
                </div>
              </div>
              <div
                v-else
                class="field"
                :class="{ full: isFull(fk, schema) }"
              >
                <label :title="schema.description || fk">{{ schema.label || fk }}</label>
                <p
                  v-if="schema.description"
                  class="desc"
                  :class="{ compact: !isFull(fk, schema) }"
                  :title="schema.description"
                >
                  {{ schema.description }}
                </p>
                <ConfigFieldControl
                  :schema="schema"
                  :model-value="readValue(row.value, fk)"
                  @update:model-value="(v) => patchValue(i, fk, v)"
                />
              </div>
            </template>
          </div>

          <ConfigJsonEditor
            v-else
            :model-value="row.value && typeof row.value === 'object' ? row.value : {}"
            :rows="4"
            @update:model-value="(v) => patchValue(i, '', v)"
          />
        </div>
      </details>
    </template>
  </div>
</template>
