<script setup lang="ts">
/**
 * map / 扁平 object：键值行编辑（headers、extraBody 等）
 */
import { computed } from 'vue';
import { NButton, NInput } from 'naive-ui';
import XrkIcon from '@/components/XrkIcon.vue';

const props = defineProps({
  modelValue: { type: Object, default: () => ({}) },
  keyPlaceholder: { type: String, default: '键' },
  valuePlaceholder: { type: String, default: '值' },
});

const emit = defineEmits(['update:modelValue']);

interface KvRow {
  key: string;
  value: string;
}

const rows = computed<KvRow[]>(() => {
  const obj = props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
    ? props.modelValue
    : {};
  const entries = Object.entries(obj).map(([k, v]) => ({
    key: k,
    value: v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v),
  }));
  return entries.length ? entries : [{ key: '', value: '' }];
});

function commit(nextRows: KvRow[]) {
  const out: Record<string, unknown> = {};
  for (const row of nextRows) {
    const k = String(row.key ?? '').trim();
    if (!k) continue;
    const raw = row.value;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          out[k] = JSON.parse(t);
          continue;
        } catch {
          /* keep string */
        }
      }
      out[k] = raw;
    } else {
      out[k] = raw;
    }
  }
  emit('update:modelValue', out);
}

function patchRow(i: number, patch: Partial<KvRow>) {
  const next = rows.value.map((r, idx) => (idx === i ? { ...r, ...patch } : { ...r }));
  commit(next);
}

function addRow() {
  commit([...rows.value, { key: '', value: '' }]);
}

function removeRow(i: number) {
  const next = rows.value.filter((_, idx) => idx !== i);
  commit(next.length ? next : [{ key: '', value: '' }]);
}
</script>

<template>
  <div class="kv-editor">
    <div v-for="(row, i) in rows" :key="i" class="kv-row">
      <NInput
        :value="row.key"
        size="small"
        class="kv-key"
        :placeholder="keyPlaceholder"
        @update:value="(v) => patchRow(i, { key: v })"
      />
      <NInput
        :value="row.value"
        size="small"
        class="kv-val"
        :placeholder="valuePlaceholder"
        @update:value="(v) => patchRow(i, { value: v })"
      />
      <NButton size="tiny" secondary class="kv-del" aria-label="删除行" @click="removeRow(i)">
        <XrkIcon name="trash" :size="12" />
      </NButton>
    </div>
    <NButton size="tiny" secondary class="kv-add" @click="addRow">
      <XrkIcon name="plus" :size="12" />
      添加键值
    </NButton>
  </div>
</template>

<style scoped>
.kv-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  min-height: 40px;
}
.kv-row {
  display: grid;
  grid-template-columns: minmax(88px, 0.4fr) minmax(0, 1fr) 28px;
  gap: 6px;
  align-items: center;
}
.kv-del {
  min-width: 28px;
  padding: 0;
  border: 1.5px solid var(--ink);
}
.kv-add {
  align-self: flex-start;
  border: 1.5px solid var(--ink);
  font-weight: 700;
  box-shadow: var(--shadow);
}
</style>
