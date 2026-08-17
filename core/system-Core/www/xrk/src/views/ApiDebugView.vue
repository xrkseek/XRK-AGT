<script>
export default { name: 'ApiDebugView' };
</script>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import { authHeaders, getServerUrl } from '@/api/client';
import FileDropZone from '@/components/FileDropZone.vue';
import XrkIcon from '@/components/XrkIcon.vue';
import { useAuthReload } from '@/composables/useAuthReload';
import { useListPaneWidth } from '@/composables/useListPaneWidth';
import { useViewport } from '@/composables/useViewport';
import { copyText } from '@/utils/http';

const { isMobile } = useViewport();
const { width: listPaneW, startResize } = useListPaneWidth();
const message = useMessage();
const catalog = ref({ apiGroups: [] });
const activeId = ref(localStorage.getItem('lastApiId') || '');
const filter = ref('');
const loading = ref(false);
const elapsedMs = ref(0);
const statusLine = ref('');
const responseText = ref('// 尚未请求');
const previewText = ref('{}');
const listOpen = ref(false);
/** @type {import('vue').Ref<File[]>} */
const selectedFiles = ref([]);

/** @type {import('vue').Ref<Record<string, string>>} */
const pathVals = ref({});
/** @type {import('vue').Ref<Record<string, string>>} */
const queryVals = ref({});
/** @type {import('vue').Ref<Record<string, string>>} */
const bodyVals = ref({});

const custom = reactive({
  method: localStorage.getItem('customApiMethod') || 'GET',
  url: localStorage.getItem('customApiUrl') || '/api/status',
  body: localStorage.getItem('customApiBody') || '{}',
});

const methodOptions = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => ({
  label: m,
  value: m,
}));

const groups = computed(() => catalog.value.apiGroups || []);

const flatApis = computed(() => {
  const out = [];
  for (const g of groups.value) {
    for (const a of g.apis || []) {
      out.push({ ...a, groupId: g.id, groupTitle: g.title || g.name || g.id });
    }
  }
  return out;
});

const filteredGroups = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value
    .map((g) => ({
      ...g,
      apis: (g.apis || []).filter((a) =>
        `${g.title} ${a.title} ${a.method} ${a.path} ${a.id}`.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.apis.length);
});

const active = computed(() => {
  if (activeId.value === 'custom') return { id: 'custom', title: '自定义请求', method: custom.method, path: custom.url };
  return flatApis.value.find((a) => a.id === activeId.value) || null;
});

const pathParamNames = computed(() => {
  if (!active.value?.path || activeId.value === 'custom') return [];
  return (active.value.path.match(/:(\w+)/g) || []).map((p) => p.slice(1));
});

const queryParams = computed(() =>
  activeId.value === 'custom' ? [] : active.value?.queryParams || [],
);
const bodyParams = computed(() =>
  activeId.value === 'custom' || (active.value?.method || 'GET').toUpperCase() === 'GET'
    ? []
    : active.value?.bodyParams || [],
);

const isMultipart = computed(() => {
  const a = active.value;
  if (!a || activeId.value === 'custom') return false;
  const rt = String(a.requestType || a.contentType || '').toLowerCase();
  if (rt.includes('multipart')) return true;
  return activeId.value === 'file-upload';
});

const fileField = computed(() => active.value?.fileField || 'file');
const fileMultiple = computed(() => active.value?.multiple !== false);

function methodTagType(method) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET') return 'success';
  if (m === 'DELETE') return 'error';
  if (m === 'PUT' || m === 'PATCH') return 'warning';
  return 'info';
}

function persistActive(id) {
  try {
    localStorage.setItem('lastApiId', id);
  } catch {
    /* ignore */
  }
}

function formatParamValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

function encodePathValue(name, val) {
  const meta = active.value?.pathParams?.[name];
  const raw = String(val ?? '');
  if (meta?.encode === false) return raw.replace(/^\/+/, '');
  // 保留路径斜杠（trash / 资源 URI 相对段）
  return raw.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function initParamState(api) {
  const pv = {};
  const qv = {};
  const bv = {};
  if (!api || api.id === 'custom') {
    pathVals.value = pv;
    queryVals.value = qv;
    bodyVals.value = bv;
    return;
  }
  const ex = catalog.value.examples?.[api.id] || {};
  for (const name of (api.path.match(/:(\w+)/g) || []).map((p) => p.slice(1))) {
    const meta = api.pathParams?.[name];
    const fromEx = ex[`path_${name}`];
    pv[name] =
      fromEx != null
        ? String(fromEx)
        : meta?.defaultValue != null
          ? String(meta.defaultValue)
          : meta?.example != null
            ? String(meta.example)
            : meta?.placeholder != null
              ? String(meta.placeholder)
              : '';
  }
  for (const p of api.queryParams || []) {
    const fromEx = ex[p.name];
    qv[p.name] =
      fromEx != null
        ? String(fromEx)
        : p.defaultValue != null
          ? String(p.defaultValue)
          : p.example != null
            ? String(p.example)
            : '';
  }
  for (const p of api.bodyParams || []) {
    const fromEx = ex[p.name];
    const raw = fromEx ?? p.defaultValue ?? p.example;
    bv[p.name] = raw == null ? '' : formatParamValue(raw);
  }
  pathVals.value = pv;
  queryVals.value = qv;
  bodyVals.value = bv;
}

function selectApi(id) {
  activeId.value = id;
  persistActive(id);
  selectedFiles.value = [];
  listOpen.value = false;
  if (id === 'custom') {
    initParamState(null);
  } else {
    const api = flatApis.value.find((a) => a.id === id);
    initParamState(api || null);
  }
  refreshPreview();
}

function buildRequestData() {
  if (activeId.value === 'custom') {
    const method = String(custom.method || 'GET').toUpperCase();
    const data = { method, url: custom.url || '' };
    if (method !== 'GET' && custom.body.trim()) {
      try {
        data.body = JSON.parse(custom.body);
      } catch {
        /* invalid json omitted */
      }
    }
    return data;
  }

  const api = flatApis.value.find((a) => a.id === activeId.value);
  if (!api) return { method: 'GET', url: '/' };
  let url = api.path || '';
  const method = (api.method || 'GET').toUpperCase();
  const data = { method, url };

  for (const name of pathParamNames.value) {
    const val = pathVals.value[name];
    if (val == null || val === '') continue;
    data.url = data.url.replace(`:${name}`, encodePathValue(name, val));
  }

  const query = {};
  for (const p of queryParams.value) {
    const val = queryVals.value[p.name];
    if (val == null || val === '') continue;
    query[p.name] = val;
  }
  if (Object.keys(query).length) data.query = query;

  if (method !== 'GET' && method !== 'HEAD') {
    const body = {};
    for (const p of bodyParams.value) {
      const raw = bodyVals.value[p.name];
      if (raw == null || raw === '') continue;
      let val = raw;
      if (p.type === 'json') {
        try {
          val = JSON.parse(raw);
        } catch {
          /* keep string */
        }
      } else if (p.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) val = n;
      } else if (p.type === 'boolean' || p.type === 'checkbox') {
        val = raw === 'true' || raw === '1' || raw === true;
      }
      body[p.name] = val;
    }
    if (Object.keys(body).length) data.body = body;
  }
  if (isMultipart.value && selectedFiles.value.length) {
    data.files = selectedFiles.value.map((f) => ({ name: f.name, size: f.size }));
    data.multipart = true;
    data.fileField = fileField.value;
  }
  return data;
}

function refreshPreview() {
  previewText.value = JSON.stringify(buildRequestData(), null, 2);
}

function fillExample() {
  if (activeId.value === 'custom') {
    message.info('自定义请求请手动填写');
    return;
  }
  const api = flatApis.value.find((a) => a.id === activeId.value);
  if (!api) return;
  const ex = catalog.value.examples?.[api.id] || {};
  for (const name of pathParamNames.value) {
    const meta = api.pathParams?.[name];
    const v = ex[`path_${name}`] ?? meta?.example ?? meta?.defaultValue ?? meta?.placeholder;
    if (v != null) pathVals.value[name] = String(v);
  }
  for (const p of api.queryParams || []) {
    const v = ex[p.name] ?? p.example ?? p.defaultValue;
    if (v != null) queryVals.value[p.name] = String(v);
  }
  for (const p of api.bodyParams || []) {
    const v = ex[p.name] ?? p.example ?? p.defaultValue;
    if (v == null) continue;
    bodyVals.value[p.name] = formatParamValue(v);
  }
  refreshPreview();
  message.success('已填充示例/默认值');
}

function resolveUrl(rawUrl, query) {
  let url = '';
  if (!rawUrl) url = getServerUrl();
  else if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('//')) url = rawUrl;
  else if (rawUrl.startsWith('/')) url = `${getServerUrl()}${rawUrl}`;
  else url = `${getServerUrl()}/${rawUrl}`;

  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += url.includes('?') ? `&${qs}` : `?${qs}`;
  }
  return url;
}

async function execute() {
  const data = buildRequestData();
  if (!data.url && activeId.value !== 'custom') {
    message.warning('请先选择 API');
    return;
  }
  if (/:(\w+)/.test(data.url || '')) {
    message.warning('请填写全部路径参数');
    return;
  }
  if (isMultipart.value && !selectedFiles.value.length) {
    message.warning('请先选择要上传的文件');
    return;
  }
  loading.value = true;
  statusLine.value = '';
  responseText.value = '';
  const start = Date.now();
  const method = (data.method || 'GET').toUpperCase();
  const url = resolveUrl(data.url, data.query);
  try {
    /** @type {RequestInit} */
    const init = { method, headers: authHeaders() };
    if (isMultipart.value) {
      const fd = new FormData();
      for (const f of selectedFiles.value) fd.append(fileField.value, f);
      if (data.body && typeof data.body === 'object') {
        for (const [k, v] of Object.entries(data.body)) {
          if (v == null) continue;
          fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
      }
      init.body = fd;
      // 勿设 Content-Type，浏览器会带 boundary
    } else {
      init.headers = authHeaders(
        method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json' },
      );
      if (data.body && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(data.body);
      }
    }
    const res = await fetch(url, init);
    elapsedMs.value = Date.now() - start;
    statusLine.value = `${res.status} ${res.statusText} · ${elapsedMs.value}ms`;
    const text = await res.text();
    try {
      responseText.value = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      responseText.value = text || '(空响应)';
    }
    message[res.ok ? 'success' : 'error'](res.ok ? '请求成功' : `请求失败: ${res.status}`);
    if (res.ok && isMultipart.value) selectedFiles.value = [];
  } catch (err) {
    elapsedMs.value = Date.now() - start;
    statusLine.value = `0 ERR · ${elapsedMs.value}ms`;
    responseText.value = JSON.stringify({ error: err?.message || String(err) }, null, 2);
    message.error(err?.message || String(err));
  } finally {
    loading.value = false;
  }
}

async function copyPreview() {
  const ok = await copyText(previewText.value);
  if (ok) message.success('已复制预览');
  else message.error('复制失败：浏览器限制或权限不足');
}

async function copyResponse() {
  const ok = await copyText(responseText.value);
  if (ok) message.success('已复制响应');
  else message.error('复制失败：浏览器限制或权限不足');
}

watch(
  [activeId, pathVals, queryVals, bodyVals, selectedFiles, () => custom.method, () => custom.url, () => custom.body],
  refreshPreview,
  { deep: true },
);

watch(
  () => [custom.method, custom.url, custom.body],
  () => {
    try {
      localStorage.setItem('customApiMethod', custom.method);
      localStorage.setItem('customApiUrl', custom.url);
      localStorage.setItem('customApiBody', custom.body);
    } catch {
      /* ignore */
    }
  },
);

async function loadCatalog() {
  try {
    const base = import.meta.env.BASE_URL || '/xrk/';
    const res = await fetch(`${base}api-config.json`);
    catalog.value = await res.json();
    if (!activeId.value) activeId.value = 'custom';
    else if (activeId.value !== 'custom' && !flatApis.value.some((a) => a.id === activeId.value)) {
      activeId.value = flatApis.value[0]?.id || 'custom';
    }
    selectApi(activeId.value);
  } catch (err) {
    message.error(`加载 api-config：${err?.message || err}`);
  }
}

onMounted(loadCatalog);
useAuthReload(loadCatalog);

function paramControl(p) {
  const t = String(p.type || 'text').toLowerCase();
  if (t === 'select') return 'select';
  if (t === 'textarea' || t === 'json') return 'textarea';
  if (t === 'password') return 'password';
  return 'input';
}
</script>

<template>
  <div
    class="api"
    :class="{ 'list-open': listOpen, 'is-mobile-page': isMobile }"
    :style="{ '--list-pane-w': `${listPaneW}px` }"
  >
    <div v-if="listOpen" class="scrim" @click="listOpen = false" />

    <aside class="brutal-card side">
      <NInput v-model:value="filter" size="small" clearable placeholder="筛选 API…" />
      <div class="list ink-scroll">
        <div class="api-group">
          <div class="group-title">自定义</div>
          <button
            type="button"
            class="api-item"
            :class="{ active: activeId === 'custom' }"
            @click="selectApi('custom')"
          >
            <NTag size="tiny" type="warning" :bordered="true">CUSTOM</NTag>
            <span class="title">自定义请求</span>
          </button>
        </div>
        <div v-for="g in filteredGroups" :key="g.id" class="api-group">
          <div class="group-title">{{ g.title || g.id }}</div>
          <button
            v-for="a in g.apis"
            :key="a.id"
            type="button"
            class="api-item"
            :class="{ active: a.id === activeId }"
            @click="selectApi(a.id)"
          >
            <NTag size="tiny" :bordered="true" :type="methodTagType(a.method)">
              {{ a.method || 'GET' }}
            </NTag>
            <span class="title">{{ a.title || a.path || a.id }}</span>
          </button>
        </div>
      </div>
      <p class="count">{{ flatApis.length }} APIs</p>
      <button
        type="button"
        class="pane-resizer"
        aria-label="调整列表宽度"
        title="拖拽调整宽度"
        @pointerdown="startResize"
      />
    </aside>

    <section class="brutal-card main">
      <template v-if="!active">
        <div class="welcome">
          <button type="button" class="list-toggle" @click="listOpen = !listOpen">
            <XrkIcon :name="listOpen ? 'close' : 'menu'" :size="14" />
            <span>{{ listOpen ? '关闭' : '选 API' }}</span>
          </button>
          <h2>API 调试中心</h2>
          <p>点「选 API」打开列表开始测试</p>
          <NEmpty description="未选择" />
        </div>
      </template>

      <template v-else>
        <header class="api-head">
          <div class="head-left">
            <button
              type="button"
              class="list-toggle"
              :title="listOpen ? '关闭列表' : '选择 API'"
              :aria-label="listOpen ? '关闭列表' : '选择 API'"
              @click="listOpen = !listOpen"
            >
              <XrkIcon :name="listOpen ? 'close' : 'menu'" :size="14" />
              <span>{{ listOpen ? '关闭' : '列表' }}</span>
            </button>
            <div class="head-meta">
              <div class="head-row">
                <h2>{{ active.title || active.id }}</h2>
                <NTag size="small" :bordered="true" :type="methodTagType(active.method)">
                  {{ active.method || 'GET' }}
                </NTag>
                <NTag v-if="isMultipart" size="small" type="warning" :bordered="true">multipart</NTag>
              </div>
              <p class="endpoint mono">{{ active.path || custom.url }}</p>
              <p v-if="active.description" class="desc">{{ active.description }}</p>
            </div>
          </div>
          <NSpace size="small" class="head-acts" :wrap="false">
            <NButton
              v-if="activeId !== 'custom'"
              size="small"
              secondary
              @click="fillExample"
            >
              填充示例
            </NButton>
            <NButton size="small" type="primary" :loading="loading" @click="execute">
              执行请求
            </NButton>
          </NSpace>
        </header>

        <div class="form-grid ink-scroll">
          <div class="form-col">
            <template v-if="activeId === 'custom'">
              <section class="form-sec">
                <h3>请求</h3>
                <div class="custom-row">
                  <div class="custom-method">
                    <label class="lbl">方法</label>
                    <NSelect v-model:value="custom.method" size="small" :options="methodOptions" />
                  </div>
                  <div class="custom-url">
                    <label class="lbl">URL</label>
                    <NInput
                      v-model:value="custom.url"
                      size="small"
                      class="mono"
                      placeholder="/api/status 或 https://..."
                    />
                  </div>
                </div>
                <template v-if="String(custom.method || 'GET').toUpperCase() !== 'GET'">
                  <label class="lbl">Body (JSON)</label>
                  <NInput
                    v-model:value="custom.body"
                    type="textarea"
                    :rows="isMobile ? 4 : 8"
                    size="small"
                    class="mono"
                    placeholder="{}"
                  />
                  <p class="hint">JSON 非法则不带 body</p>
                </template>
              </section>
            </template>

            <template v-else>
              <section v-if="isMultipart" class="form-sec">
                <h3>文件上传</h3>
                <FileDropZone
                  v-model="selectedFiles"
                  :multiple="fileMultiple"
                  :hint="`字段名 ${fileField} · 成功后自动清空`"
                />
              </section>

              <section v-if="pathParamNames.length" class="form-sec">
                <h3>路径参数</h3>
                <div v-for="name in pathParamNames" :key="name" class="field">
                  <label class="lbl">
                    {{ active.pathParams?.[name]?.label || name }}
                    <span class="req">*</span>
                  </label>
                  <NInput
                    v-model:value="pathVals[name]"
                    size="small"
                    class="mono"
                    :placeholder="active.pathParams?.[name]?.placeholder || name"
                  />
                </div>
              </section>

              <section v-if="queryParams.length" class="form-sec">
                <h3>查询参数</h3>
                <div v-for="p in queryParams" :key="p.name" class="field">
                  <label class="lbl">
                    {{ p.label || p.name }}
                    <span v-if="p.required" class="req">*</span>
                  </label>
                  <p v-if="p.hint" class="hint">{{ p.hint }}</p>
                  <NSelect
                    v-if="paramControl(p) === 'select'"
                    v-model:value="queryVals[p.name]"
                    size="small"
                    clearable
                    :options="(p.options || []).map((o) => ({ label: o.label, value: String(o.value) }))"
                    placeholder="请选择"
                  />
                  <NInput
                    v-else-if="paramControl(p) === 'textarea'"
                    v-model:value="queryVals[p.name]"
                    type="textarea"
                    size="small"
                    :rows="3"
                    :placeholder="p.placeholder || ''"
                  />
                  <NInput
                    v-else
                    v-model:value="queryVals[p.name]"
                    size="small"
                    class="mono"
                    :placeholder="p.placeholder || ''"
                  />
                </div>
              </section>

              <section v-if="bodyParams.length" class="form-sec">
                <h3>请求体</h3>
                <div v-for="p in bodyParams" :key="p.name" class="field">
                  <label class="lbl">
                    {{ p.label || p.name }}
                    <span v-if="p.required" class="req">*</span>
                  </label>
                  <p v-if="p.hint" class="hint">{{ p.hint }}</p>
                  <NSelect
                    v-if="paramControl(p) === 'select'"
                    v-model:value="bodyVals[p.name]"
                    size="small"
                    clearable
                    :options="(p.options || []).map((o) => ({ label: o.label, value: String(o.value) }))"
                  />
                  <NInput
                    v-else-if="paramControl(p) === 'textarea'"
                    v-model:value="bodyVals[p.name]"
                    type="textarea"
                    size="small"
                    class="mono"
                    :rows="4"
                    :placeholder="p.placeholder || ''"
                  />
                  <NInput
                    v-else-if="paramControl(p) === 'password'"
                    v-model:value="bodyVals[p.name]"
                    type="password"
                    show-password-on="click"
                    size="small"
                    :placeholder="p.placeholder || ''"
                  />
                  <NInput
                    v-else
                    v-model:value="bodyVals[p.name]"
                    size="small"
                    class="mono"
                    :placeholder="p.placeholder || ''"
                  />
                </div>
              </section>

              <p
                v-if="!isMultipart && !pathParamNames.length && !queryParams.length && !bodyParams.length"
                class="hint bare"
              >
                此 API 无额外参数，可直接点右上角执行。
              </p>
            </template>
          </div>

          <div class="preview-col">
            <details class="pane preview-pane" :open="!isMobile">
              <summary class="pane-h">
                <span>请求预览</span>
                <NSpace size="small" @click.stop>
                  <NButton size="tiny" secondary @click.prevent="refreshPreview">刷新</NButton>
                  <NButton size="tiny" secondary @click.prevent="copyPreview">复制</NButton>
                </NSpace>
              </summary>
              <NInput
                v-model:value="previewText"
                type="textarea"
                class="mono preview-ta"
                :rows="isMobile ? 4 : 8"
                size="small"
                readonly
              />
            </details>
          </div>
        </div>

        <section class="pane resp-pane">
          <header class="pane-h">
            <span>响应</span>
            <NSpace size="small" align="center">
              <span class="mono status">{{ statusLine }}</span>
              <NButton size="tiny" secondary @click="copyResponse">复制</NButton>
            </NSpace>
          </header>
          <div class="resp ink-scroll">
            <pre class="resp-pre mono">{{ responseText }}</pre>
          </div>
        </section>
      </template>
    </section>
  </div>
</template>

<style scoped>
.api {
  display: grid;
  grid-template-columns: var(--list-pane-w, 260px) minmax(0, 1fr);
  gap: var(--gap);
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.side,
.main {
  padding: 8px;
  min-height: 0;
  overflow: hidden;
}
.side {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
  min-width: 0;
}
.list {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  border: 2px solid var(--ink);
  border-radius: 8px;
  padding: 4px;
  background: color-mix(in srgb, var(--paper-2) 28%, var(--card));
}
.api-group {
  margin-bottom: 6px;
}
.group-title {
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--muted);
  padding: 4px 6px 2px;
  text-transform: uppercase;
}
.api-item {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
  border: 1.5px solid transparent;
  background: transparent;
  border-radius: 6px;
  padding: 5px 6px;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.api-item:hover,
.api-item.active {
  border-color: var(--ink);
  background: color-mix(in srgb, var(--green) 28%, var(--card));
}
.api-item .title {
  font-size: var(--font-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--muted);
}
.list-toggle {
  display: none;
}
.scrim {
  display: none;
}
.main {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, max-content) minmax(0, 1fr);
  gap: 8px;
  align-content: stretch;
}
.welcome {
  grid-row: 1 / -1;
  padding: 24px 8px;
  text-align: center;
  min-height: 0;
  overflow: auto;
}
.welcome h2 {
  margin: 0 0 6px;
  font-size: 16px;
}
.api-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--ink);
  flex-shrink: 0;
}
.head-left {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.head-meta {
  min-width: 0;
  flex: 1;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.head-acts {
  flex-shrink: 0;
}
.hint.bare {
  margin: 0;
  padding: 4px 0;
}
.api-head h2 {
  margin: 0;
  font-size: 15px;
}
.endpoint {
  margin: 4px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
}
.desc {
  margin: 4px 0 0;
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.4;
}
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
  gap: 8px;
  align-items: stretch;
  min-height: 0;
  max-height: min(38vh, 320px);
  overflow: auto;
}
.form-col,
.preview-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.preview-col {
  position: sticky;
  top: 0;
  align-self: stretch;
}
.preview-pane {
  flex: 1 1 auto;
  min-height: 140px;
}
.preview-pane .preview-ta {
  flex: 1 1 auto;
  min-height: 120px;
}
.preview-pane :deep(.n-input),
.preview-pane :deep(.n-input-wrapper),
.preview-pane :deep(textarea) {
  height: 100%;
  min-height: 120px;
}
.form-sec {
  border: 2px solid var(--ink);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: var(--card);
  box-shadow: var(--shadow);
}
.form-sec h3 {
  margin: 0 0 8px;
  font-size: var(--font-sm);
  font-weight: 800;
  padding-bottom: 6px;
  border-bottom: 2px solid color-mix(in srgb, var(--ink) 35%, transparent);
}
.custom-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
  align-items: end;
  margin-bottom: 6px;
}
.custom-method,
.custom-url {
  min-width: 0;
}
.custom-row .lbl {
  margin-bottom: 3px;
}
.field {
  margin-bottom: 8px;
}
.lbl {
  display: block;
  font-size: var(--font-xs);
  font-weight: 700;
  margin-bottom: 3px;
}
.req {
  color: var(--red);
}
.hint {
  margin: 0 0 4px;
  font-size: var(--font-xs);
  color: var(--muted);
}
.pane {
  border: 2px solid var(--ink);
  border-radius: 8px;
  padding: 6px 8px;
  background: color-mix(in srgb, var(--paper) 35%, var(--card));
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}
.pane-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-xs);
  font-weight: 800;
  list-style: none;
  flex-shrink: 0;
  user-select: none;
}
details > summary.pane-h {
  cursor: pointer;
}
.pane-h::-webkit-details-marker {
  display: none;
}
details.pane > summary.pane-h::before {
  content: '▸';
  display: inline-block;
  margin-right: 4px;
  transition: transform 0.12s ease;
}
details.pane[open] > summary.pane-h::before {
  transform: rotate(90deg);
}
.status {
  font-size: var(--font-xs);
  color: var(--muted);
  font-weight: 600;
}
.resp-pane {
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.resp {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  font-size: var(--font-xs);
  border: 1.5px solid color-mix(in srgb, var(--ink) 25%, transparent);
  border-radius: 6px;
  padding: 6px;
  background: var(--card);
}
.resp-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: inherit;
  line-height: 1.45;
}
@media (max-width: 980px) {
  .api {
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
  }
  .side,
  .main {
    padding: 6px;
  }
  .main {
    gap: 6px;
  }
  .form-sec {
    padding: 6px 8px;
    margin-bottom: 6px;
    box-shadow: none;
  }
  .form-sec h3 {
    margin: 0 0 6px;
    padding-bottom: 4px;
  }
  .custom-row {
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 6px;
  }
  .list-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    border: 1.5px solid var(--ink);
    border-radius: 6px;
    background: var(--yellow);
    font: inherit;
    font-size: var(--font-xs);
    font-weight: 800;
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
  .welcome .list-toggle {
    width: auto;
    height: auto;
    gap: 4px;
    padding: 6px 10px;
    margin: 0 auto 10px;
  }
  .welcome .list-toggle span {
    display: inline;
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
  .api .pane-resizer {
    display: none;
  }
  .api.list-open .side {
    display: flex;
    position: fixed;
    z-index: 50;
    left: max(var(--gap), env(safe-area-inset-left));
    top: calc(var(--topbar-h) + var(--gap) * 2 + 36px);
    bottom: max(var(--gap), env(safe-area-inset-bottom));
    width: min(320px, calc(100vw - var(--gap) * 2));
    box-shadow: 4px 4px 0 var(--ink);
  }
  .api.is-mobile-page.list-open .side {
    top: max(48px, env(safe-area-inset-top) + 44px);
    bottom: calc(var(--shell-tabbar-h, 52px) + env(safe-area-inset-bottom));
  }
  .main {
    flex: 1;
    min-height: 0;
  }
  .form-grid {
    grid-template-columns: 1fr;
    gap: 6px;
    max-height: min(32vh, 240px);
  }
  .preview-col {
    position: static;
  }
  .preview-pane {
    min-height: 0;
  }
  .api-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 4px 6px;
    padding-bottom: 6px;
  }
  .head-left {
    display: contents;
  }
  .head-meta {
    min-width: 0;
  }
  .head-meta h2 {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .head-acts {
    align-self: start;
  }
  .head-meta .desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .endpoint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-xs);
  }
  .resp-pane {
    min-height: 0;
  }
  .resp {
    min-height: 0;
  }
  .preview-pane:not([open]) {
    padding-bottom: 4px;
  }
}
@media (max-width: 480px) {
  .api-head {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .head-acts {
    grid-column: 1 / -1;
    justify-self: stretch;
  }
  .head-acts :deep(.n-space) {
    width: 100%;
    justify-content: flex-end;
  }
  .custom-row {
    grid-template-columns: 1fr;
  }
}
</style>
