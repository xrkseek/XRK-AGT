<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NEmpty,
  NInput,
  NModal,
  NSpace,
  NSpin,
  useMessage,
} from 'naive-ui';
import { apiFetch, authHeaders, getServerUrl } from '@/api/client';
import { breadcrumbParts, formatBytes, toolLabel } from '@/chat/workspace';
import { normalizeWorkspaceId } from '@/chat/llm-settings';
import type { LoosePayload } from '@/types';

/** /api/ai/workspace/files 返回的目录条目 */
interface WorkspaceFile {
  path: string;
  name: string;
  type: string;
  size?: number;
}

/** /api/ai/workspace/audit 返回的调用记录 */
interface AuditEntry {
  ok?: boolean;
  tool?: unknown;
  ts?: number;
  detail?: string;
}

/** apiFetch 返回 union，这里收成宽松载荷 */
function asPayload(v: unknown): LoosePayload {
  return v as LoosePayload;
}

/** catch 里的 err 是 unknown，统一取可读文案 */
function errText(err: unknown): string {
  const msg = (err as { message?: unknown } | null | undefined)?.message;
  return msg ? String(msg) : String(err);
}

const props = defineProps({
  workspace: { type: String, default: 'default' },
});

const emit = defineEmits<{
  (e: 'update:workspace', value: string): void;
  (e: 'presets', value: string[]): void;
}>();

const message = useMessage();
const loading = ref(false);
const dir = ref('');
const rootHint = ref('');
const files = ref<WorkspaceFile[]>([]);
const uploadInput = ref<HTMLInputElement | null>(null);

const agentsOpen = ref(false);
const agentsText = ref('');
const agentsSaving = ref(false);

const auditOpen = ref(false);
const auditLoading = ref(false);
const auditEntries = ref<AuditEntry[]>([]);

const crumbs = computed(() => breadcrumbParts(dir.value));
const wsId = computed(() => normalizeWorkspaceId(props.workspace));

async function refresh({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  if (!silent) loading.value = true;
  try {
    const q = new URLSearchParams({ workspace: wsId.value, dir: dir.value || '' });
    const data = asPayload(await apiFetch(`/api/ai/workspace/files?${q}`, { timeoutMs: 10000 }));
    rootHint.value = data?.root || data?.hint || '';
    files.value = Array.isArray(data?.files) ? (data.files as WorkspaceFile[]) : [];
  } catch (err) {
    files.value = [];
    if (!silent) message.error(errText(err));
  } finally {
    loading.value = false;
  }
}

function openDir(path: string): void {
  dir.value = path || '';
  void refresh();
}

async function downloadFile(path: string): Promise<void> {
  try {
    const q = new URLSearchParams({ workspace: wsId.value, path });
    const res = await fetch(`${getServerUrl()}/api/ai/workspace/files/download?${q}`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.message || `下载失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'download';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    message.error(errText(err));
  }
}

async function createWorkspace(): Promise<void> {
  const name = window.prompt('新建工作区名称（字母/数字/中文/下划线）');
  if (!name?.trim()) return;
  try {
    const created = asPayload(await apiFetch('/api/ai/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name.trim() }),
    }));
    const list = asPayload(await apiFetch('/api/ai/workspaces'));
    emit('presets', list?.workspaces || []);
    const id = created?.id || name.trim();
    emit('update:workspace', normalizeWorkspaceId(id));
    dir.value = '';
    message.success('工作区已创建');
    await refresh();
  } catch (err) {
    message.error(errText(err));
  }
}

async function onUploadChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement | null;
  const list = input?.files;
  if (!list?.length) return;
  const fd = new FormData();
  for (const f of list) fd.append('file', f);
  try {
    const q = new URLSearchParams({ workspace: wsId.value, dir: dir.value || '' });
    const res = await fetch(`${getServerUrl()}/api/ai/workspace/files/upload?${q}`, {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });
    const json = asPayload(await res.json().catch(() => ({})));
    if (!res.ok || json.success === false) {
      throw new Error(json.message || '上传失败');
    }
    message.success(`已上传 ${json.files?.length || list.length} 个文件`);
    await refresh({ silent: true });
  } catch (err) {
    message.error(errText(err));
  } finally {
    if (uploadInput.value) uploadInput.value.value = '';
  }
}

async function openRules(): Promise<void> {
  try {
    const data = asPayload(
      await apiFetch(`/api/ai/workspace/agents?workspace=${encodeURIComponent(wsId.value)}`),
    );
    agentsText.value = data?.content || '';
    agentsOpen.value = true;
  } catch (err) {
    message.error(errText(err));
  }
}

async function saveRules(): Promise<void> {
  agentsSaving.value = true;
  try {
    await apiFetch(`/api/ai/workspace/agents?workspace=${encodeURIComponent(wsId.value)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: agentsText.value, workspace: wsId.value }),
    });
    message.success('规则已保存');
    agentsOpen.value = false;
  } catch (err) {
    message.error(errText(err));
  } finally {
    agentsSaving.value = false;
  }
}

async function openAudit(): Promise<void> {
  auditOpen.value = true;
  auditLoading.value = true;
  try {
    const data = asPayload(
      await apiFetch(`/api/ai/workspace/audit?workspace=${encodeURIComponent(wsId.value)}&limit=50`),
    );
    auditEntries.value = Array.isArray(data?.entries) ? (data.entries as AuditEntry[]) : [];
  } catch (err) {
    auditEntries.value = [];
    message.error(errText(err));
  } finally {
    auditLoading.value = false;
  }
}

watch(
  () => props.workspace,
  () => {
    dir.value = '';
    void refresh();
  },
  { immediate: true },
);

defineExpose({ refresh });
</script>

<template>
  <div class="ws-panel">
    <div class="ws-actions">
      <button type="button" class="link" @click="createWorkspace">新建</button>
      <button type="button" class="link" @click="uploadInput?.click()">上传</button>
      <button type="button" class="link" @click="openRules">规则</button>
      <button type="button" class="link" @click="openAudit">审计</button>
      <button type="button" class="icon" title="刷新" @click="refresh()">↻</button>
      <input
        ref="uploadInput"
        type="file"
        multiple
        hidden
        @change="onUploadChange"
      />
    </div>
    <p v-if="rootHint" class="root mono" :title="rootHint">{{ rootHint }}</p>
    <nav class="crumbs" aria-label="工作区路径">
      <template v-for="(c, i) in crumbs" :key="c.dir + i">
        <span v-if="i" class="sep">/</span>
        <button type="button" class="crumb" @click="openDir(c.dir)">{{ c.label }}</button>
      </template>
    </nav>
    <NSpin :show="loading" size="small">
      <div class="file-list">
        <NEmpty v-if="!files.length" description="此目录暂无文件" size="small" />
        <button
          v-for="f in files"
          :key="f.path"
          type="button"
          class="file-row"
          @click="f.type === 'dir' ? openDir(f.path) : null"
        >
          <span class="ico">{{ f.type === 'dir' ? '📁' : '📄' }}</span>
          <span class="name" :title="f.path">{{ f.name }}</span>
          <span class="meta">{{ f.type === 'dir' ? '文件夹' : formatBytes(f.size) }}</span>
          <span
            v-if="f.type === 'file'"
            class="dl"
            title="下载"
            @click.stop="downloadFile(f.path)"
          >↓</span>
        </button>
      </div>
    </NSpin>

    <NModal v-model:show="agentsOpen" preset="card" title="AGENTS.md" style="width: min(560px, 92vw)">
      <p class="modal-sub">工作区根目录规则，保存后下次对话生效</p>
      <NInput v-model:value="agentsText" type="textarea" :rows="14" class="mono" placeholder="# Agent 规则…" />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="agentsOpen = false">取消</NButton>
          <NButton type="primary" :loading="agentsSaving" @click="saveRules">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal v-model:show="auditOpen" preset="card" title="工具审计" style="width: min(480px, 92vw)">
      <p class="modal-sub">当前工作区 MCP 工具调用记录</p>
      <NSpin :show="auditLoading">
        <div class="audit-list">
          <NEmpty v-if="!auditEntries.length" description="暂无审计记录" size="small" />
          <article
            v-for="(e, i) in auditEntries"
            :key="i"
            class="audit-card"
            :class="{ fail: e.ok === false }"
          >
            <header>
              <strong>{{ toolLabel(e.tool) }}</strong>
              <span class="badge" :class="e.ok === false ? 'bad' : 'ok'">
                {{ e.ok === false ? '失败' : '成功' }}
              </span>
            </header>
            <time>{{ new Date(e.ts || 0).toLocaleString() }}</time>
            <p v-if="e.ok === false && e.detail">{{ e.detail }}</p>
          </article>
        </div>
      </NSpin>
    </NModal>
  </div>
</template>

<style scoped>
.ws-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}
.ws-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.link {
  border: none;
  background: none;
  color: var(--ink);
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  text-decoration: underline;
  padding: 0;
}
.icon {
  margin-left: auto;
  border: 2px solid var(--ink);
  border-radius: 6px;
  background: var(--paper-2);
  width: 24px;
  height: 24px;
  font: inherit;
  line-height: 1;
}
.root {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  font-size: 11px;
}
.crumb {
  border: none;
  background: none;
  font: inherit;
  font-weight: 700;
  color: var(--ink);
  padding: 0 2px;
}
.sep {
  opacity: 0.4;
}
.file-list {
  max-height: 132px;
  overflow: auto;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--card);
}
.file-row {
  width: 100%;
  display: grid;
  grid-template-columns: 16px 1fr auto auto;
  gap: 4px;
  align-items: center;
  border: none;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background: transparent;
  font: inherit;
  font-size: var(--font-xs);
  text-align: left;
  padding: 3px 5px;
}
.file-row:hover {
  background: color-mix(in srgb, var(--yellow) 28%, transparent);
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  color: var(--muted);
  font-size: var(--font-xs);
}
.dl {
  font-weight: 800;
  padding: 0 4px;
}
.modal-sub {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--muted);
}
.audit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.audit-card {
  border: 2px solid var(--ink);
  border-radius: 8px;
  padding: 8px;
  background: color-mix(in srgb, var(--green) 12%, var(--card));
}
.audit-card.fail {
  background: color-mix(in srgb, var(--red) 14%, var(--card));
}
.audit-card header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.audit-card time {
  font-size: 11px;
  color: var(--muted);
}
.audit-card p {
  margin: 4px 0 0;
  font-size: 12px;
}
.badge {
  font-size: var(--font-xs);
  font-weight: 800;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--ink);
}
.badge.ok {
  background: var(--green);
}
.badge.bad {
  background: var(--pink);
}
</style>
