<script>
export default { name: 'ConfigView' };
</script>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import { apiFetch, apiJson } from '@/api/client';
import { deepClone } from '@/utils/http';
import { useAuthReload } from '@/composables/useAuthReload';
import {
  arraySchemasFromFlatTemplates,
  buildArraySchemaIndex,
  buildDirtyFlat,
  extractActiveSchema,
  formatExample,
  formatGroupLabel,
  groupFields,
  isFieldFullSpan,
  normalizeFlatFields,
  resolveArrayItemFields,
  resolveFieldControl,
  fieldNestedFields,
  sameFieldValue,
  valuesFromFlat,
} from '@/config/flat';
import ConfigArrayForm from '@/components/ConfigArrayForm.vue';
import ConfigFieldControl from '@/components/ConfigFieldControl.vue';
import ConfigJsonEditor from '@/components/ConfigJsonEditor.vue';
import ConfigKeyedMapForm from '@/components/ConfigKeyedMapForm.vue';
import XrkIcon from '@/components/XrkIcon.vue';
import { useListPaneWidth } from '@/composables/useListPaneWidth';
import { useViewport } from '@/composables/useViewport';

const message = useMessage();
const dialog = useDialog();
const { isMobile } = useViewport();
const { width: listPaneW, startResize } = useListPaneWidth();
const loading = ref(false);
const saving = ref(false);
const listOpen = ref(false);
const configs = ref([]);
const filter = ref('');
const selected = ref(localStorage.getItem('lastConfigName') || '');
const selectedChild = ref(localStorage.getItem('lastConfigChild') || '');
const mode = ref(localStorage.getItem('configEditorMode') || 'form');
const dense = ref(localStorage.getItem('configEditorDense') === '1');

const fields = ref([]);
const arraySchemas = ref({});
const values = reactive({});
const original = reactive({});
const jsonText = ref('{}');
const jsonBaseline = ref('{}');
const children = ref([]);
const validateErrorPaths = ref([]);
/** 阻止 selectedChild 回滚时二次触发 */
let suppressChildWatch = false;

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return configs.value;
  return configs.value.filter((c) => {
    const hay = `${c.displayName || ''} ${c.name || ''} ${c.description || ''}`.toLowerCase();
    return hay.includes(q);
  });
});

const groups = computed(() => groupFields(fields.value));
const showGroupHeaders = computed(() => {
  if (groups.value.length !== 1) return true;
  const only = groups.value[0]?.label;
  return only !== '基础';
});
const selectedConfig = computed(() => configs.value.find((c) => c.name === selected.value) || null);
/** system / llm_factories 等：structure 带 configs 子项 */
const isMultiFile = computed(() => Boolean(
  selectedConfig.value?.configs && typeof selectedConfig.value.configs === 'object',
));
const editingMultiChild = computed(() => isMultiFile.value && Boolean(selectedChild.value));

const editorTitle = computed(() => {
  if (editingMultiChild.value) {
    const opt = childOptions.value.find((o) => o.value === selectedChild.value);
    return opt?.label || selectedChild.value;
  }
  return selectedConfig.value?.displayName || selected.value || '未选择';
});

const editorDesc = computed(() => {
  if (editingMultiChild.value) return `${selected.value} / ${selectedChild.value}`;
  if (selectedConfig.value?.description) return selectedConfig.value.description;
  if (selected.value) return selected.value;
  return '';
});

const dirtyCount = computed(() => {
  if (mode.value === 'json' && jsonText.value !== jsonBaseline.value) {
    try {
      const parsed = JSON.parse(jsonText.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 1;
      const shadow = valuesFromFlat(parsed, fields.value);
      const n = Object.keys(
        buildDirtyFlat(shadow, original, fields.value, arraySchemas.value),
      ).length;
      return n || 1;
    } catch {
      return 1;
    }
  }
  return Object.keys(buildDirtyFlat(values, original, fields.value, arraySchemas.value)).length;
});

const dirtyPaths = computed(() => {
  try {
    let flat;
    if (mode.value === 'json') {
      const parsed = JSON.parse(jsonText.value);
      const shadow = valuesFromFlat(parsed, fields.value);
      flat = buildDirtyFlat(shadow, original, fields.value, arraySchemas.value);
    } else {
      flat = buildDirtyFlat(values, original, fields.value, arraySchemas.value);
    }
    return Object.keys(flat || {}).slice(0, 8);
  } catch {
    return [];
  }
});

const dirtySummary = computed(() => {
  if (!dirtyPaths.value.length) return '';
  const more = dirtyCount.value > dirtyPaths.value.length
    ? ` 等 ${dirtyCount.value} 项`
    : '';
  return dirtyPaths.value.join(', ') + more;
});

const childOptions = computed(() => {
  const cfg = selectedConfig.value;
  if (cfg?.configs && typeof cfg.configs === 'object') {
    return Object.entries(cfg.configs).map(([key, meta]) => ({
      label: meta?.displayName || key,
      value: key,
    }));
  }
  return children.value.map((c) => ({
    label: typeof c === 'string' ? c : c.label || c.name || c.path,
    value: typeof c === 'string' ? c : c.name || c.path || c.id,
  }));
});

function confirmDiscard() {
  const n = dirtyCount.value;
  if (!n) return Promise.resolve(true);
  return new Promise((resolve) => {
    dialog.warning({
      title: '放弃修改',
      content: `有 ${n} 项未保存${dirtySummary.value ? `（${dirtySummary.value}）` : ''}，确定放弃？`,
      positiveText: '放弃',
      negativeText: '取消',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
}

function flatToNested(flat) {
  const out = {};
  for (const [p, v] of Object.entries(flat || {})) {
    const parts = String(p).split('.').filter(Boolean);
    if (!parts.length) continue;
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

function ensureNestedObj(path) {
  if (!values[path] || typeof values[path] !== 'object' || Array.isArray(values[path])) {
    values[path] = {};
  }
  return values[path];
}

function nestedFieldEntries(f) {
  return Object.entries(fieldNestedFields(f));
}

function ensureObjValue(path) {
  const cur = values[path];
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) return cur;
  return {};
}

function setNestedValue(parentPath, key, v) {
  const obj = ensureNestedObj(parentPath);
  obj[key] = v;
}

function persistSelection() {
  try {
    if (selected.value) localStorage.setItem('lastConfigName', selected.value);
    localStorage.setItem('lastConfigChild', selectedChild.value || '');
  } catch {
    /* ignore */
  }
}

function setMode(next) {
  if (next === mode.value) return;
  if (mode.value === 'json' && next === 'form') {
    if (!applyJsonToValues()) return;
  }
  mode.value = next;
  try {
    localStorage.setItem('configEditorMode', next);
  } catch {
    /* ignore */
  }
  if (next === 'json') syncJsonFromValues();
}

function toggleDense() {
  dense.value = !dense.value;
  try {
    localStorage.setItem('configEditorDense', dense.value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function clearValues() {
  for (const k of Object.keys(values)) delete values[k];
  for (const k of Object.keys(original)) delete original[k];
}

function applyFlatData(flatSchema, flatData, structure = null) {
  const list = normalizeFlatFields(flatSchema);
  fields.value = list;
  clearValues();
  validateErrorPaths.value = [];
  const fromStructure = buildArraySchemaIndex(
    extractActiveSchema(structure, selected.value, selectedChild.value) || { fields: {} },
  );
  const fromTemplates = arraySchemasFromFlatTemplates(flatSchema);
  const merged = { ...fromTemplates, ...fromStructure };
  for (const f of list) {
    if (f.type !== 'array<object>' && f.component !== 'arrayform') continue;
    if ((!merged[f.path] || !Object.keys(merged[f.path]).length) && f.itemFields) {
      merged[f.path] = f.itemFields;
    }
  }
  arraySchemas.value = merged;
  const next = valuesFromFlat(flatData || {}, list);
  Object.assign(values, next);
  Object.assign(original, deepClone(next));
  syncJsonFromValues();
}

function syncJsonFromValues() {
  const obj = {};
  for (const f of fields.value) obj[f.path] = values[f.path];
  const text = JSON.stringify(obj, null, 2);
  jsonText.value = text;
  jsonBaseline.value = text;
}

function applyJsonToValues() {
  let parsed;
  try {
    parsed = JSON.parse(jsonText.value);
  } catch {
    message.error('JSON 无法解析');
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    message.error('JSON 需为对象（path → value）');
    return false;
  }
  const next = valuesFromFlat(parsed, fields.value);
  for (const k of Object.keys(values)) delete values[k];
  Object.assign(values, next);
  jsonBaseline.value = jsonText.value;
  return true;
}

async function loadList() {
  loading.value = true;
  try {
    const data = await apiFetch('/api/config/list');
    configs.value = Array.isArray(data?.configs) ? data.configs : Array.isArray(data) ? data : [];
    if (!selected.value && configs.value[0]) {
      selected.value = configs.value[0].name;
    }
    if (selected.value) await loadOne(selected.value, { force: true });
  } catch (err) {
    message.error(err?.message || String(err));
  } finally {
    loading.value = false;
  }
}

function childQuery() {
  if (isMultiFile.value && selectedChild.value) {
    return `?path=${encodeURIComponent(selectedChild.value)}`;
  }
  return '';
}

/**
 * @param {string} name
 * @param {{ force?: boolean }} [opts]
 */
async function loadOne(name, opts = {}) {
  if (!name) return;
  if (!opts.force && !(await confirmDiscard())) return;
  const cfg = configs.value.find((c) => c.name === name);
  const multi = Boolean(cfg?.configs && typeof cfg.configs === 'object');
  if (multi && !selectedChild.value) {
    children.value = Object.keys(cfg.configs);
    fields.value = [];
    arraySchemas.value = {};
    clearValues();
    syncJsonFromValues();
    return;
  }

  await loadFlat(name);
}

async function loadFlat(name) {
  loading.value = true;
  try {
    const q = childQuery();
    const tasks = [
      apiFetch(`/api/config/${encodeURIComponent(name)}/flat-structure${q}`),
      apiFetch(`/api/config/${encodeURIComponent(name)}/flat${q}`),
      apiFetch(`/api/config/${encodeURIComponent(name)}/structure`).catch(() => null),
    ];
    const [schemaRes, dataRes, structureRes] = await Promise.all(tasks);
    const flatSchema = schemaRes?.flat ?? schemaRes;
    const flatData = dataRes?.flat ?? dataRes;
    const structure = structureRes?.structure ?? structureRes;
    applyFlatData(flatSchema, flatData, structure);
    persistSelection();
  } catch (err) {
    message.error(err?.message || String(err));
    fields.value = [];
    arraySchemas.value = {};
    clearValues();
  } finally {
    loading.value = false;
  }
}

function itemFieldsFor(f) {
  return resolveArrayItemFields(f.path, arraySchemas.value, f);
}

async function save() {
  if (!selected.value) return;
  if (isMultiFile.value && !selectedChild.value) {
    message.warning('请先选择子配置');
    return;
  }
  if (mode.value === 'json' && !applyJsonToValues()) return;

  const flat = buildDirtyFlat(values, original, fields.value, arraySchemas.value);
  if (!Object.keys(flat).length) {
    message.info('无变更');
    return;
  }

  saving.value = true;
  validateErrorPaths.value = [];
  try {
    if (!isMultiFile.value) {
      const allFlat = {};
      for (const f of fields.value) allFlat[f.path] = values[f.path];
      const data = flatToNested(allFlat);
      try {
        const res = await apiJson(
          `/api/config/${encodeURIComponent(selected.value)}/validate`,
          { data },
          'POST',
        );
        const validation = res?.validation ?? res;
        if (validation && validation.valid === false) {
          const errs = Array.isArray(validation.errors) ? validation.errors : [String(validation)];
          message.error(`校验失败: ${errs.join('; ')}`);
          validateErrorPaths.value = errs
            .map((e) => {
              const m = String(e).match(/字段\s+([\w.]+)/);
              return m?.[1];
            })
            .filter(Boolean);
          return;
        }
      } catch (err) {
        message.error(err?.message || String(err));
        return;
      }
    }

    const body = { flat, backup: true, validate: true };
    if (isMultiFile.value && selectedChild.value) body.path = selectedChild.value;
    await apiJson(`/api/config/${encodeURIComponent(selected.value)}/batch-set`, body, 'POST');
    message.success(`已保存 ${Object.keys(flat).length} 项`);
    await loadFlat(selected.value);
  } catch (err) {
    message.error(err?.message || String(err));
  } finally {
    saving.value = false;
  }
}

async function backup() {
  if (!selected.value || isMultiFile.value) {
    message.warning('多文件配置请在子配置内保存（会自动备份）');
    return;
  }
  try {
    const res = await apiJson(`/api/config/${encodeURIComponent(selected.value)}/backup`, {}, 'POST');
    message.success(res?.backupPath ? `已备份：${res.backupPath}` : '已备份');
  } catch (err) {
    message.error(err?.message || String(err));
  }
}

async function resetCfg() {
  if (!selected.value || isMultiFile.value) {
    message.warning('多文件子配置请在服务端重置对应 yaml');
    return;
  }
  const ok = await new Promise((resolve) => {
    dialog.warning({
      title: '重置配置',
      content: `确认将 ${selected.value} 重置为默认值？`,
      positiveText: '重置',
      negativeText: '取消',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
  if (!ok) return;
  try {
    await apiJson(`/api/config/${encodeURIComponent(selected.value)}/reset`, { backup: true }, 'POST');
    message.success('已重置');
    await loadFlat(selected.value);
  } catch (err) {
    message.error(err?.message || String(err));
  }
}

async function selectConfig(name) {
  if (selected.value === name) {
    listOpen.value = false;
    return;
  }
  if (!(await confirmDiscard())) return;
  suppressChildWatch = true;
  selected.value = name;
  selectedChild.value = '';
  children.value = [];
  listOpen.value = false;
  persistSelection();
  queueMicrotask(() => {
    suppressChildWatch = false;
  });
  void loadOne(name, { force: true });
}

async function goBackChild() {
  if (!editingMultiChild.value) return;
  if (!(await confirmDiscard())) return;
  suppressChildWatch = true;
  selectedChild.value = '';
  persistSelection();
  fields.value = [];
  arraySchemas.value = {};
  clearValues();
  syncJsonFromValues();
  queueMicrotask(() => {
    suppressChildWatch = false;
  });
}

function fieldControl(f) {
  return resolveFieldControl(f);
}

function isDirty(path) {
  const f = fields.value.find((x) => x.path === path);
  if (!f) return false;
  if (f.type === 'array<object>' || f.component === 'arrayform') {
    const itemFields = arraySchemas.value[f.path] || f.itemFields || {};
    const flat = buildDirtyFlat(
      { [path]: values[path] },
      { [path]: original[path] },
      [f],
      { [path]: itemFields },
    );
    return Boolean(flat[path]);
  }
  return !sameFieldValue(values[path], original[path], f.type, f.component);
}

function formatJsonEditor() {
  try {
    const parsed = JSON.parse(jsonText.value);
    jsonText.value = JSON.stringify(parsed, null, 2);
    message.success('已格式化');
  } catch {
    message.error('JSON 无法解析，无法格式化');
  }
}

watch(selectedChild, async (v, prev) => {
  if (suppressChildWatch) return;
  if (!isMultiFile.value) return;
  if (v === prev) return;
  if (!(await confirmDiscard())) {
    suppressChildWatch = true;
    selectedChild.value = prev;
    queueMicrotask(() => {
      suppressChildWatch = false;
    });
    return;
  }
  persistSelection();
  if (v) void loadFlat(selected.value);
  else {
    fields.value = [];
    arraySchemas.value = {};
    clearValues();
    syncJsonFromValues();
  }
});

onMounted(loadList);
useAuthReload(loadList);
</script>

<template>
  <div
    class="config"
    :class="{ dense, 'list-open': listOpen, 'is-mobile-page': isMobile }"
    :style="{ '--list-pane-w': `${listPaneW}px` }"
  >
    <div v-if="listOpen" class="scrim" @click="listOpen = false" />

    <aside class="brutal-card side">
      <div class="side-head">
        <strong>配置管理</strong>
        <span class="sub">flat schema · batch-set</span>
      </div>
      <NInput v-model:value="filter" size="small" clearable placeholder="平铺搜索…" />
      <ul class="cfg-list">
        <li
          v-for="c in filtered"
          :key="c.name"
          class="cfg-item"
          :class="{ active: selected === c.name, multi: Boolean(c.configs) }"
          @click="selectConfig(c.name)"
        >
          <div class="cfg-meta">
            <span class="name">{{ c.displayName || c.name }}</span>
            <span v-if="c.description" class="desc">{{ c.description }}</span>
            <span v-if="c.configs" class="multi-hint">点选后进入子配置</span>
          </div>
          <span v-if="c.configs" class="cfg-tag">多文件</span>
        </li>
      </ul>
      <NEmpty v-if="!filtered.length" description="无配置项" size="small" />
      <NButton size="small" block @click="loadList">刷新列表</NButton>
      <button
        type="button"
        class="pane-resizer"
        aria-label="调整列表宽度"
        title="拖拽调整宽度"
        @pointerdown="startResize"
      />
    </aside>

    <section class="brutal-card editor">
      <header>
        <div class="hdr-left">
          <button
            type="button"
            class="list-toggle"
            :title="listOpen ? '关闭列表' : '选择配置'"
            :aria-label="listOpen ? '关闭列表' : '选择配置'"
            @click="listOpen = !listOpen"
          >
            <XrkIcon :name="listOpen ? 'close' : 'menu'" :size="14" />
            <span>{{ listOpen ? '关闭' : '列表' }}</span>
          </button>
          <button
            v-if="editingMultiChild"
            type="button"
            class="back-btn"
            title="返回子配置列表"
            @click="goBackChild"
          >
            <XrkIcon name="collapse" :size="14" />
            <span>返回</span>
          </button>
          <div class="hdr-titles">
            <h2>{{ editorTitle }}</h2>
            <p v-if="editorDesc" class="hdr-desc" :class="{ mono: editingMultiChild }">{{ editorDesc }}</p>
          </div>
          <NTag v-if="dirtyCount" size="small" type="warning" :bordered="true" :title="dirtySummary">
            {{ dirtyCount }} 未保存
          </NTag>
          <span v-if="dirtySummary && !isMobile" class="dirty-hint" :title="dirtySummary">{{ dirtySummary }}</span>
        </div>
        <div class="editor-toolbar" role="toolbar" aria-label="配置操作">
          <div class="tb-group" role="group" aria-label="编辑模式">
            <NButton
              size="small"
              :type="mode === 'form' ? 'primary' : 'default'"
              class="tb-btn"
              :quaternary="mode !== 'form'"
              @click="setMode('form')"
            >
              <XrkIcon name="form" :size="14" />
              <span>表单</span>
            </NButton>
            <NButton
              size="small"
              :type="mode === 'json' ? 'primary' : 'default'"
              class="tb-btn"
              :quaternary="mode !== 'json'"
              @click="setMode('json')"
            >
              <XrkIcon name="json" :size="14" />
              <span>JSON</span>
            </NButton>
          </div>

          <span class="tb-sep" aria-hidden="true" />

          <div class="tb-group" role="group" aria-label="布局密度">
            <NButton
              size="small"
              class="tb-btn"
              :type="dense ? 'primary' : 'default'"
              :quaternary="!dense"
              :title="dense ? '当前紧凑（三列），点击切换舒适' : '当前舒适（两列），点击切换紧凑'"
              @click="toggleDense"
            >
              <XrkIcon :name="dense ? 'dense' : 'comfortable'" :size="14" />
              <span>{{ dense ? '紧凑' : '舒适' }}</span>
            </NButton>
          </div>

          <NButton size="small" type="primary" class="tb-btn tb-save" :loading="saving" @click="save">
            <XrkIcon name="save" :size="14" />
            <span>保存</span>
          </NButton>

          <span class="tb-sep" aria-hidden="true" />

          <div class="tb-group" role="group" aria-label="文件操作">
            <NButton size="small" quaternary class="tb-btn" :loading="loading" @click="loadOne(selected)">
              <XrkIcon name="reload" :size="14" />
              <span>重载</span>
            </NButton>
            <NButton size="small" quaternary class="tb-btn" @click="backup">
              <XrkIcon name="backup" :size="14" />
              <span>备份</span>
            </NButton>
            <NButton size="small" quaternary class="tb-btn" @click="resetCfg">
              <XrkIcon name="reset" :size="14" />
              <span>重置</span>
            </NButton>
          </div>
        </div>
      </header>

      <div class="editor-body ink-scroll">
        <NSpin :show="loading">
          <div v-if="!selected" class="placeholder">
            <NEmpty description="从左侧选择配置" />
          </div>

          <div v-else-if="isMultiFile && !selectedChild" class="sys-chooser">
            <p class="hint">多文件配置，请选择子项：</p>
            <div class="sys-grid">
              <button
                v-for="opt in childOptions"
                :key="opt.value"
                type="button"
                class="sys-card"
                @click="selectedChild = opt.value"
              >
                <strong class="sys-card-title">{{ opt.label }}</strong>
                <span class="sys-card-path mono">{{ selected }}/{{ opt.value }}</span>
              </button>
            </div>
            <NEmpty v-if="!childOptions.length" description="未定义子配置" size="small" />
          </div>

          <div v-else-if="mode === 'json'" class="json-wrap">
            <div class="json-bar">
              <NButton size="tiny" secondary @click="formatJsonEditor">格式化</NButton>
              <NButton size="tiny" secondary @click="syncJsonFromValues">从表格同步</NButton>
              <span v-if="dirtyCount" class="json-dirty">{{ dirtyCount }} 未保存</span>
            </div>
            <NInput v-model:value="jsonText" type="textarea" class="mono" :rows="20" />
            <p class="hint">JSON 为 path → value 扁平对象；保存时只提交相对原始值的变更。切回表单会应用当前 JSON。</p>
          </div>

          <div v-else-if="!fields.length" class="placeholder">
            <NEmpty description="无扁平字段（可切 JSON，或检查多文件子配置）" />
          </div>

          <div v-else class="form-wrap">
            <section v-for="g in groups" :key="g.label" class="group">
              <div v-if="showGroupHeaders" class="group-h">
                <div class="group-h-text">
                  <h3>{{ formatGroupLabel(g.label) }}</h3>
                  <p v-if="g.desc" class="group-desc">{{ g.desc }}</p>
                </div>
                <span class="group-count">{{ g.items.length }} 项</span>
              </div>
              <div v-else class="group-rail" aria-hidden="true" />
              <div class="field-grid">
                <div
                  v-for="f in g.items"
                  :key="f.path"
                  class="field"
                  :class="{
                    full: isFieldFullSpan(f),
                    dirty: isDirty(f.path),
                    invalid: validateErrorPaths.includes(f.path),
                  }"
                  :title="f.path"
                >
                  <label :for="`f-${f.path}`" class="fname" :title="f.description || f.path">
                    {{ f.label }}
                    <span v-if="f.required" class="req">*</span>
                  </label>
                  <p
                    v-if="f.description"
                    class="desc"
                    :class="{ compact: !isFieldFullSpan(f) }"
                    :title="f.description"
                  >
                    {{ f.description }}
                  </p>
                  <div class="ctrl">
                    <ConfigArrayForm
                      v-if="fieldControl(f) === 'array'"
                      v-model="values[f.path]"
                      :path="f.path"
                      :label="f.itemLabel || f.label || '条目'"
                      :item-fields="itemFieldsFor(f)"
                      :dense="dense"
                    />
                    <ConfigKeyedMapForm
                      v-else-if="fieldControl(f) === 'keyed'"
                      :model-value="ensureObjValue(f.path)"
                      :label="f.itemLabel || f.label || '条目'"
                      :item-fields="fieldNestedFields(f)"
                      :example="f.example"
                      :key-label="f.keyLabel || '键'"
                      :key-placeholder="f.keyPlaceholder || '输入键名，如 * 或 chat_id'"
                      :dense="dense"
                      @update:model-value="(v) => (values[f.path] = v && typeof v === 'object' ? v : {})"
                    />
                    <div
                      v-else-if="fieldControl(f) === 'nested' && nestedFieldEntries(f).length"
                      class="nested-block field-grid"
                    >
                      <div
                        v-for="[nk, ns] in nestedFieldEntries(f)"
                        :key="nk"
                        class="field"
                        :class="{
                          full: isFieldFullSpan({ ...ns, path: `${f.path}.${nk}` }),
                        }"
                      >
                        <label class="fname" :title="ns.description || nk">{{ ns.label || nk }}</label>
                        <p
                          v-if="ns.description"
                          class="desc"
                          :class="{
                            compact: !isFieldFullSpan({ ...ns, path: `${f.path}.${nk}` }),
                          }"
                          :title="ns.description"
                        >
                          {{ ns.description }}
                        </p>
                        <div class="ctrl">
                          <ConfigFieldControl
                            :schema="ns"
                            :model-value="ensureNestedObj(f.path)[nk]"
                            @update:model-value="(v) => setNestedValue(f.path, nk, v)"
                          />
                        </div>
                      </div>
                    </div>
                    <ConfigJsonEditor
                      v-else-if="fieldControl(f) === 'nested' || fieldControl(f) === 'json'"
                      :model-value="ensureObjValue(f.path)"
                      @update:model-value="(v) => (values[f.path] = v && typeof v === 'object' ? v : {})"
                    />
                    <ConfigFieldControl
                      v-else
                      :input-id="`f-${f.path}`"
                      :schema="f"
                      :model-value="values[f.path]"
                      @update:model-value="(v) => (values[f.path] = v)"
                    />
                  </div>
                  <div
                    v-if="f.example != null && f.example !== ''"
                    class="example"
                  >
                    <strong>此为示例：</strong>
                    <pre>{{ formatExample(f.example) }}</pre>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </NSpin>
      </div>
    </section>
  </div>
</template>

<style scoped>
.config {
  --config-border: color-mix(in srgb, var(--ink) 55%, transparent);
  --config-border-strong: var(--ink);
  --config-divider: color-mix(in srgb, var(--ink) 42%, transparent);
  display: grid;
  grid-template-columns: var(--list-pane-w, 260px) minmax(0, 1fr);
  gap: var(--gap);
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
  container-name: config;
}
.list-toggle,
.scrim {
  display: none;
}
.side,
.editor {
  padding: 8px;
  min-height: 0;
  overflow: hidden;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
  position: relative;
  min-width: 0;
}
.side-head {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex-shrink: 0;
}
.side-head strong { font-size: 13px; }
.side-head .sub { font-size: var(--font-xs); color: var(--muted); }
.side > .n-input,
.side > .n-button { flex-shrink: 0; }
.cfg-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  overflow: auto;
  flex: 1 1 0;
  min-height: 0;
  border: 2px solid var(--ink);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: color-mix(in srgb, var(--paper-2) 30%, var(--card));
}
.cfg-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 9px;
  border: 1.5px solid var(--config-border);
  border-radius: 7px;
  background: var(--card);
  cursor: pointer;
  flex-shrink: 0;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
.cfg-item:hover {
  border-color: var(--ink);
  background: color-mix(in srgb, var(--cyan) 16%, var(--card));
}
.cfg-item.active {
  border-color: var(--ink);
  background: color-mix(in srgb, var(--yellow) 48%, var(--card));
  box-shadow: var(--shadow);
}
.cfg-item.multi {
  border-width: 2px;
  background: color-mix(in srgb, var(--cyan) 10%, var(--card));
}
.cfg-item.multi .name {
  font-size: 14px;
}
.multi-hint {
  font-size: var(--font-xs);
  color: var(--muted);
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--paper-2);
  font: inherit;
  font-size: var(--font-sm);
  font-weight: 700;
  padding: 4px 10px;
  box-shadow: var(--shadow);
  flex: 0 0 auto;
  cursor: pointer;
  touch-action: manipulation;
}
.back-btn:hover {
  background: color-mix(in srgb, var(--yellow) 35%, var(--card));
}
.back-btn:active {
  transform: translate(1px, 1px);
  box-shadow: none;
}
.cfg-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
}
.cfg-item .name,
.cfg-item .desc {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.cfg-item .name {
  font-size: var(--font-ui);
  font-weight: 700;
  line-height: 1.3;
}
.cfg-item .desc {
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cfg-tag {
  flex: 0 0 auto;
  align-self: flex-start;
  font-size: var(--font-xs);
  font-weight: 800;
  line-height: 1.5;
  padding: 1px 8px;
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  background: var(--cyan);
  white-space: nowrap;
}
.editor {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}
.editor-body {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
}
.editor-body > :deep(.n-spin-container) { min-height: 100%; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--ink);
}
.hdr-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.hdr-titles { min-width: 0; }
header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
}
.hdr-desc {
  margin: 3px 0 0;
  font-size: var(--font-sm);
  color: var(--muted);
  line-height: 1.4;
  max-width: min(52ch, 100%);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.editor-toolbar {
  flex: 0 1 auto;
}
.form-wrap,
.json-wrap {
  overflow-x: hidden;
  min-width: 0;
  min-height: 0;
}
.json-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.json-dirty {
  font-size: var(--font-xs);
  font-weight: 800;
  color: var(--ink);
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  padding: 1px 8px;
  background: color-mix(in srgb, var(--pink) 28%, var(--card));
}
.group {
  position: relative;
  margin-bottom: 8px;
  border: 1.5px solid var(--ink);
  border-radius: 7px;
  padding: 0;
  background: var(--card);
  overflow: hidden;
}
.group::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--cyan);
  border-right: 1.5px solid var(--ink);
  z-index: 1;
}
.group + .group { margin-top: 2px; }
.group-h {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 6px 10px 6px 12px;
  background: color-mix(in srgb, var(--yellow) 40%, var(--paper-2));
  border-bottom: 1.5px solid var(--ink);
}
.group-rail {
  height: 2px;
  background: var(--ink);
}
.group-h-text { min-width: 0; flex: 1; }
.group h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.group-desc {
  margin: 4px 0 0;
  font-size: var(--font-sm);
  color: var(--muted);
  line-height: 1.4;
}
.group-count {
  font-size: var(--font-xs);
  color: var(--ink);
  font-weight: 800;
  flex-shrink: 0;
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  padding: 1px 8px;
  line-height: 1.6;
  background: var(--card);
}
.group .field-grid { padding: 4px 10px 8px 14px; }
.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 16px;
  row-gap: 6px;
  align-items: stretch;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 8px 4px 10px;
  border-bottom: 1px solid var(--config-divider);
}
.field.full { grid-column: 1 / -1; }
.field.dirty {
  background: color-mix(in srgb, var(--pink) 12%, transparent);
  border-radius: 4px;
  box-shadow: inset 3px 0 0 var(--pink);
}
.field.invalid {
  background: color-mix(in srgb, var(--red) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--red);
}
.dirty-hint {
  font-size: var(--font-xs);
  opacity: 0.65;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
}
.dense .field-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: 12px;
}
.fname {
  display: block;
  font-size: var(--font-sm);
  font-weight: 700;
  line-height: 1.3;
  margin: 0;
  word-break: keep-all;
  overflow-wrap: break-word;
}
.req { color: var(--red); }
.desc {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.desc.compact {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ctrl {
  flex: 0 0 auto;
  min-height: 28px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  width: 100%;
}
.nested-block {
  width: 100%;
  border: 1px dashed color-mix(in srgb, var(--ink) 28%, transparent);
  border-radius: 6px;
  padding: 8px;
  box-sizing: border-box;
}
.example {
  margin-top: 6px;
  padding: 6px 8px;
  border: 1.5px dashed var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--paper-2) 50%, var(--card));
  font-size: var(--font-xs);
  line-height: 1.4;
}
.example pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--mono);
  font-size: var(--font-xs);
}
.hint { margin: 4px 0 0; font-size: var(--font-xs); color: var(--muted); }
.placeholder { padding: 20px 0; }
.sys-chooser { padding: 4px 0; min-width: 0; }
.sys-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 168px), 1fr));
  gap: 10px;
  margin-top: 10px;
  min-width: 0;
}
.sys-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  padding: 16px 14px;
  min-height: 88px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  border: 2px solid var(--ink);
  border-radius: 10px;
  background: color-mix(in srgb, var(--cyan) 14%, var(--card));
  font: inherit;
  box-shadow: var(--shadow);
  cursor: pointer;
}
.sys-card:hover {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 var(--ink);
  background: color-mix(in srgb, var(--yellow) 28%, var(--card));
}
.sys-card-title,
.sys-card-path {
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.sys-card-title {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
}
.sys-card-path {
  font-size: var(--font-sm);
  color: var(--muted);
  line-height: 1.4;
}
@media (max-width: 900px) {
  .config {
    display: flex;
    flex-direction: column;
    grid-template-columns: none;
  }
  .list-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    border: 1.5px solid var(--ink);
    border-radius: 6px;
    background: var(--cyan);
    font: inherit;
    width: 32px;
    height: 32px;
    padding: 0;
    box-shadow: var(--shadow);
    flex: 0 0 auto;
    touch-action: manipulation;
  }
  .list-toggle span {
    display: none;
  }
  .list-toggle:active {
    transform: translate(1px, 1px);
    box-shadow: none;
  }
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 40;
    background: color-mix(in srgb, #000 45%, transparent);
  }
  .side {
    display: none;
  }
  .config .pane-resizer {
    display: none;
  }
  .config.list-open .side {
    display: flex;
    flex-direction: column;
    position: fixed;
    z-index: 50;
    left: max(var(--gap), env(safe-area-inset-left));
    top: calc(var(--topbar-h) + var(--gap) * 2 + 36px);
    bottom: max(var(--gap), env(safe-area-inset-bottom));
    width: min(320px, calc(100vw - var(--gap) * 2));
    box-shadow: 4px 4px 0 var(--ink);
  }
  .config.is-mobile-page.list-open .side {
    top: max(48px, env(safe-area-inset-top) + 44px);
    bottom: calc(var(--shell-tabbar-h, 52px) + env(safe-area-inset-bottom));
  }
  .config.is-mobile-page .tb-btn span,
  .config.is-mobile-page .cfg-tb-btn span {
    font-size: var(--font-xs);
  }
  .editor {
    flex: 1;
    min-height: 0;
  }
  /* 开关 + 标题同一行；工具栏整宽换行 */
  header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 6px 8px;
  }
  .hdr-left {
    display: contents;
  }
  .hdr-titles {
    min-width: 0;
  }
  header h2 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hdr-desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: none;
  }
  .editor-toolbar {
    grid-column: 1 / -1;
    width: 100%;
    gap: 6px;
    overflow-x: auto;
    flex-wrap: nowrap;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
}
</style>
