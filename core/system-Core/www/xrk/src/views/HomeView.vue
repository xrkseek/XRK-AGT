<script>
export default { name: 'HomeView' };
</script>

<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { NButton, NEmpty, NSpin, useMessage } from 'naive-ui';
import { apiFetch } from '@/api/client';
import {
  extractMetrics,
  formatLoadTime,
  pushNetHistory,
} from '@/home/metrics';
import { useHomeCharts } from '@/home/useHomeCharts';
import { useViewport } from '@/composables/useViewport';
import { useAuthReload } from '@/composables/useAuthReload';

const { isMobile } = useViewport();
const message = useMessage();
const loading = ref(false);
const refreshing = ref(false);

const metrics = reactive({
  cpu: 0,
  mem: 0,
  disk: 0,
  uptime: '--',
  cpuText: '--',
  memText: '--',
  diskText: '--',
});

const host = reactive({
  hostname: '—',
  platform: '—',
  arch: '—',
  nodeVersion: '—',
  cpuModel: '—',
  cpuCores: '—',
  loadavg: ['—'],
  loadavgText: '—',
  memUsedText: '—',
  memFreeText: '—',
  memTotalText: '—',
  heapUsed: '—',
  rss: '—',
  swapPct: 0,
  swapText: '—',
  rxText: '—',
  txText: '—',
  botPort: '—',
  botUrl: '—',
});

const disks = ref([]);
const ifaces = ref([]);
/** 接口失败时若仍展示缓存，告知用户别当成实时鉴权成功 */
const staleHint = ref('');

const cpuRef = ref(null);
const memRef = ref(null);
const netRef = ref(null);
const cpuVal = ref(0);
const memVal = ref(0);

const netHistory = reactive({
  netRx: Array(60).fill(0),
  netTx: Array(60).fill(0),
  _lastUpdate: null,
});

const { paint } = useHomeCharts({
  cpuEl: cpuRef,
  memEl: memRef,
  netEl: netRef,
  cpu: cpuVal,
  mem: memVal,
  history: netHistory,
});

const bots = ref([]);
const processes = ref([]);
const pluginMeta = reactive({
  total: 0,
  withRules: 0,
  withTasks: 0,
  loadTime: '—',
  error: '',
});
const pluginChips = ref([]);
const workflowMeta = reactive({ enabled: 0, total: 0, error: '' });
const workflowChips = ref([]);

let pollTimer = null;
let lastFetch = 0;
const CACHE_KEY = 'xrk.homeDataCache';
const CACHE_TTL = 5 * 60 * 1000;
const MIN_INTERVAL = 12000;

function applyOverview(data) {
  if (!data) return;
  const m = extractMetrics(data);
  metrics.cpu = m.cpu;
  metrics.mem = m.mem;
  metrics.disk = m.disk;
  metrics.uptime = m.uptime;
  metrics.cpuText = `${m.cpu.toFixed(1)}%`;
  metrics.memText = `${Number(m.mem).toFixed(1)}%`;
  metrics.diskText = `${m.disk.toFixed(1)}%`;
  cpuVal.value = m.cpu;
  memVal.value = m.mem;

  const d = m.detail || {};
  Object.assign(host, {
    hostname: d.hostname ?? '—',
    platform: d.platform ?? '—',
    arch: d.arch ?? '—',
    nodeVersion: d.nodeVersion ?? '—',
    cpuModel: d.cpuModel ?? '—',
    cpuCores: d.cpuCores ?? '—',
    loadavg: d.loadavg ?? ['—'],
    loadavgText: d.loadavgText ?? (Array.isArray(d.loadavg) ? d.loadavg.join(' · ') : '—'),
    memUsedText: d.memUsedText ?? '—',
    memFreeText: d.memFreeText ?? '—',
    memTotalText: d.memTotalText ?? '—',
    heapUsed: d.heapUsed ?? '—',
    rss: d.rss ?? '—',
    swapPct: d.swapPct ?? 0,
    swapText: d.swapText ?? '—',
    rxText: d.rxText ?? '—',
    txText: d.txText ?? '—',
    botPort: d.botPort ?? '—',
    botUrl: d.botUrl ?? '—',
  });
  disks.value = Array.isArray(d.disks) ? d.disks : [];
  ifaces.value = Array.isArray(d.ifaces) ? d.ifaces : [];

  pushNetHistory(netHistory, data);

  bots.value = Array.isArray(data.bots) ? data.bots : [];
  processes.value = Array.isArray(data.processesTop5) ? data.processesTop5 : [];

  const workflows = data.workflows ?? {};
  const panelWf = data.panels?.workflows ?? {};
  const stats = panelWf.stats ?? workflows.stats ?? {};
  const total = stats.total ?? panelWf.total ?? workflows.total ?? 0;
  const enabled = stats.enabled ?? panelWf.enabled ?? workflows.enabled ?? 0;
  const items =
    Array.isArray(workflows.items) && workflows.items.length
      ? workflows.items
      : panelWf.items ?? [];
  workflowMeta.enabled = enabled;
  workflowMeta.total = total;
  workflowMeta.error = '';
  workflowChips.value = items.map((item, i) => {
    const name = item.name ?? 'workflow';
    const on = item.enabled !== false;
    return {
      seed: `${name}-${i}`,
      label: name,
      badge: on ? '' : '停',
      disabled: !on,
      popoverTitle: name,
      desc: (item.description ?? '').trim() || '暂无描述',
      facts: [
        { label: '优先级', value: item.priority ?? '—' },
        { label: '状态', value: on ? '已启用' : '未启用' },
      ],
    };
  });

  nextTick(() => paint());
}

function applyPlugins(payload) {
  if (!payload) return;
  const summary = payload.summary ?? {};
  const list = Array.isArray(payload.plugins) ? payload.plugins : [];
  pluginMeta.total = summary.totalPlugins ?? list.length;
  pluginMeta.withRules = summary.withRules ?? 0;
  pluginMeta.withTasks = summary.withTasks ?? summary.taskCount ?? 0;
  pluginMeta.loadTime = formatLoadTime(summary.totalLoadTime ?? 0);
  pluginMeta.error = '';
  pluginChips.value = list.map((p, i) => {
    const key = p.key ?? p.name ?? `p${i}`;
    const label = p.name ?? p.key ?? 'plugin';
    return {
      seed: key,
      label,
      popoverTitle: label,
      popoverKey: String(key),
      desc: (p.dsc ?? '暂无描述').trim() || '暂无描述',
      facts: [
        { label: '优先级', value: p.priority ?? '—' },
        { label: '规则条数', value: Number(p.rule) || 0 },
        { label: '定时任务', value: p.task > 0 ? '是' : '否' },
      ],
    };
  });
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - (data._cacheTime || 0) > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, _cacheTime: Date.now() }));
  } catch {
    /* quota */
  }
}

function botInitial(bot) {
  return (bot.nickname || '').slice(0, 2) || String(bot.uin || '').slice(-2) || '??';
}

function botSub(bot) {
  if (bot.device) return bot.tasker || '未知 Tasker';
  const friends = bot.stats?.friends ?? 0;
  const groups = bot.stats?.groups ?? 0;
  return `${bot.tasker || '未知 Tasker'} · ${friends} 好友 · ${groups} 群组`;
}

function procWarn(n) {
  return Number(n) > 50;
}

async function load({ force = false, silent = false } = {}) {
  const now = Date.now();
  if (!force && now - lastFetch < MIN_INTERVAL) return;
  lastFetch = now;

  if (!silent) loading.value = true;
  else refreshing.value = true;

  try {
    const [overviewSettled, pluginsSettled] = await Promise.allSettled([
      apiFetch('/api/system/overview?withHistory=1', { timeoutMs: 10000 }),
      apiFetch('/api/plugins/summary', { timeoutMs: 5000 }),
    ]);

    if (overviewSettled.status === 'fulfilled') {
      const data = overviewSettled.value || {};
      applyOverview(data);
      saveCache(data);
      staleHint.value = '';
    } else {
      const errMsg = overviewSettled.reason?.message || '概览加载失败';
      const cached = loadCache();
      if (cached) {
        applyOverview(cached);
        const ageMin = Math.max(1, Math.round((Date.now() - (cached._cacheTime || 0)) / 60000));
        staleHint.value = /未授权|401/i.test(errMsg)
          ? `鉴权失败，显示约 ${ageMin} 分钟前的缓存（请填写 X-API-Key）`
          : `加载失败，显示约 ${ageMin} 分钟前的缓存：${errMsg}`;
      } else {
        staleHint.value = '';
        if (!silent) message.warning(errMsg);
      }
    }

    if (pluginsSettled.status === 'fulfilled') {
      applyPlugins(pluginsSettled.value || {});
    } else {
      pluginMeta.error = pluginsSettled.reason?.message || '加载失败';
      pluginChips.value = [];
    }
  } finally {
    loading.value = false;
    refreshing.value = false;
    nextTick(() => paint());
  }
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!document.hidden) void load({ silent: true });
  }, 60000);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function onVisibility() {
  if (!document.hidden) void load({ force: true, silent: true });
}

onMounted(() => {
  const cached = loadCache();
  if (cached) applyOverview(cached);
  void load({ force: true });
  startPoll();
  document.addEventListener('visibilitychange', onVisibility);
});

onActivated(() => {
  startPoll();
  nextTick(() => paint());
  void load({ silent: true });
});

onDeactivated(() => {
  stopPoll();
});

onUnmounted(() => {
  stopPoll();
  document.removeEventListener('visibilitychange', onVisibility);
});

watch(
  () => [metrics.cpu, metrics.mem, netHistory.netRx.length],
  () => nextTick(() => paint()),
);

useAuthReload(() => load({ force: true }));

const statCards = computed(() => [
  {
    k: 'CPU 使用率',
    v: metrics.cpuText,
    c: 'var(--pink)',
    bar: metrics.cpu,
    sub: `${host.cpuCores} 核 · 负载 ${host.loadavgText}`,
  },
  {
    k: '内存使用',
    v: metrics.memText,
    c: 'var(--cyan)',
    bar: metrics.mem,
    sub: `${host.memUsedText} / ${host.memTotalText} · Heap ${host.heapUsed}`,
  },
  {
    k: '磁盘使用',
    v: metrics.diskText,
    c: 'var(--yellow)',
    bar: metrics.disk,
    sub: disks.value[0]
      ? `${disks.value[0].usedText} / ${disks.value[0].sizeText}`
      : `${disks.value.length} 卷`,
  },
  {
    k: '运行时间',
    v: metrics.uptime,
    c: 'var(--green)',
    bar: null,
    sub: `↓ ${host.rxText} · ↑ ${host.txText}`,
  },
]);

const onlineBots = computed(() => bots.value.filter((b) => b.online).length);

const hostFacts = computed(() => [
  { k: '主机名', v: host.hostname },
  { k: '系统', v: `${host.platform} / ${host.arch}` },
  { k: 'Node', v: host.nodeVersion },
  { k: 'CPU', v: `${host.cpuCores} 核` },
  { k: '负载', v: host.loadavgText },
  { k: '服务端口', v: String(host.botPort) },
  { k: 'RSS', v: host.rss },
  { k: 'Swap', v: host.swapText },
]);
</script>

<template>
  <div class="home-page" :class="{ 'is-mobile-page': isMobile }">
    <NSpin :show="loading && !metrics.cpuText.includes('%')">
      <div class="status-board">
        <header class="board-head">
          <div>
            <h2 class="board-title">状态台</h2>
            <p class="board-sub">资源 · 主机 · 机器人</p>
          </div>
          <NButton size="tiny" type="primary" :loading="refreshing" @click="load({ force: true })">
            刷新
          </NButton>
        </header>

        <div v-if="staleHint" class="stale-banner" role="status">{{ staleHint }}</div>

        <div class="metrics-row" role="list">
          <div
            v-for="s in statCards"
            :key="s.k"
            class="metric"
            role="listitem"
            :style="{ '--c': s.c }"
          >
            <span class="metric-k">{{ s.k }}</span>
            <span class="metric-v mono">{{ s.v }}</span>
            <span v-if="s.sub" class="metric-sub">{{ s.sub }}</span>
            <span v-if="s.bar != null" class="metric-bar" role="presentation">
              <i :style="{ width: `${Math.min(100, Math.max(0, s.bar))}%` }" />
            </span>
          </div>
        </div>

        <section class="board-section host-block">
          <header class="sec-h">
            <h3>主机</h3>
            <span class="mono muted truncate" :title="host.cpuModel">{{ host.cpuModel }}</span>
          </header>
          <dl class="fact-row">
            <div v-for="f in hostFacts" :key="f.k" class="fact">
              <dt>{{ f.k }}</dt>
              <dd class="mono">{{ f.v }}</dd>
            </div>
          </dl>
        </section>

        <div class="split">
          <section class="board-section">
            <header class="sec-h">
              <h3>机器人</h3>
              <span v-if="bots.length" class="muted">
                <strong class="accent-text">{{ onlineBots }}</strong>/{{ bots.length }} 在线
              </span>
            </header>
            <div v-if="!bots.length" class="empty-pad">
              <NEmpty description="暂无机器人" size="small" />
            </div>
            <ul v-else class="bot-list">
              <li v-for="(bot, i) in bots" :key="bot.uin || bot.id || i" class="bot-row">
                <div class="bot-avatar">{{ botInitial(bot) }}</div>
                <div class="bot-body">
                  <div class="bot-name">{{ bot.nickname ?? bot.uin ?? '未知' }}</div>
                  <div class="bot-sub">{{ botSub(bot) }}</div>
                </div>
                <img
                  v-if="bot.avatar && !bot.device"
                  class="bot-face"
                  :src="bot.avatar"
                  :alt="bot.nickname || ''"
                  @error="($e) => ($e.target.style.display = 'none')"
                />
                <span class="online-dot" :class="{ on: bot.online }" />
              </li>
            </ul>
          </section>

          <section class="board-section">
            <header class="sec-h">
              <h3>运行时</h3>
            </header>
            <div class="runtime-line">
              <span>插件</span>
              <template v-if="pluginMeta.error">
                <span class="muted">{{ pluginMeta.error }}</span>
              </template>
              <template v-else>
                <span class="mono">
                  {{ pluginMeta.total }} · 规则 {{ pluginMeta.withRules }} · 定时 {{ pluginMeta.withTasks }} · {{ pluginMeta.loadTime }}
                </span>
              </template>
            </div>
            <div class="runtime-line">
              <span>工作流</span>
              <span class="mono">{{ workflowMeta.enabled }}/{{ workflowMeta.total }} 启用</span>
            </div>
            <ul v-if="pluginChips.length || workflowChips.length" class="chip-list">
              <li v-for="c in pluginChips.slice(0, 12)" :key="'p-' + c.key" class="signal-tag">{{ c.label || c.key }}</li>
              <li v-for="c in workflowChips.slice(0, 8)" :key="'w-' + c.key" class="signal-tag wf">{{ c.label || c.key }}</li>
            </ul>
          </section>
        </div>

        <details class="board-section secondary">
          <summary>网络 · 进程 · 磁盘</summary>
          <div class="net-wrap">
            <canvas id="netChart" ref="netRef" />
          </div>
          <table class="proc-table">
            <thead>
              <tr>
                <th>进程</th>
                <th>PID</th>
                <th>CPU</th>
                <th>内存</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!processes.length">
                <td colspan="4" class="muted center">暂无进程数据</td>
              </tr>
              <tr v-for="(p, i) in processes" :key="p.pid || i">
                <td class="name">{{ p.name || '未知进程' }}</td>
                <td class="mono muted">{{ p.pid ?? '—' }}</td>
                <td class="mono" :class="{ warn: procWarn(p.cpu) }">{{ Number(p.cpu || 0).toFixed(1) }}%</td>
                <td class="mono" :class="{ warn: procWarn(p.mem) }">{{ Number(p.mem || 0).toFixed(1) }}%</td>
              </tr>
            </tbody>
          </table>
          <ul v-if="disks.length" class="disk-list">
            <li v-for="d in disks" :key="d.id" class="disk-row">
              <div class="disk-top">
                <strong class="mono">{{ d.label }}</strong>
                <span class="mono">{{ d.pct.toFixed(1) }}%</span>
              </div>
              <div class="mini-bar">
                <i
                  :style="{
                    width: `${Math.min(100, d.pct)}%`,
                    background: d.pct > 85 ? 'var(--red)' : d.pct > 70 ? 'var(--yellow)' : 'var(--green)',
                  }"
                />
              </div>
              <div class="disk-sub mono">{{ d.usedText }} / {{ d.sizeText }}</div>
            </li>
          </ul>
          <ul v-if="ifaces.length" class="iface-list">
            <li v-for="n in ifaces" :key="n.name" class="iface-row">
              <strong>{{ n.name }}</strong>
              <span class="mono">{{ n.address }}</span>
              <span class="mono muted">{{ n.mac }}</span>
            </li>
          </ul>
        </details>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.home-page {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
  padding: 2px;
}
.status-board {
  display: flex;
  flex-direction: column;
  gap: var(--section-gap);
  padding-bottom: 12px;
  max-width: 1100px;
}
.board-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
}
.board-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.03em;
}
.board-sub {
  margin: 2px 0 0;
  font-size: var(--font-xs);
  color: var(--muted);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.stale-banner {
  padding: 8px 10px;
  font-size: var(--font-xs);
  color: var(--ink);
  background: color-mix(in srgb, var(--yellow) 18%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--yellow) 45%, transparent);
  border-radius: var(--radius);
}
.metrics-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: color-mix(in srgb, var(--line) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--line) 22%, transparent);
  border-radius: var(--radius);
  overflow: hidden;
}
.metric {
  background: var(--surface);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 2px solid var(--c);
}
.metric-k {
  font-size: var(--font-xs);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.metric-v {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.metric-sub {
  font-size: var(--font-xs);
  color: var(--muted);
}
.metric-bar {
  margin-top: 6px;
  height: 3px;
  background: color-mix(in srgb, var(--line) 12%, transparent);
  border-radius: 1px;
  overflow: hidden;
}
.metric-bar i {
  display: block;
  height: 100%;
  background: var(--c);
  transition: width 280ms var(--ease-out);
}
.board-section {
  border: 1px solid color-mix(in srgb, var(--line) 22%, transparent);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0;
  overflow: hidden;
}
.sec-h {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 14%, transparent);
}
.sec-h h3 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
}
.muted { color: var(--muted); }
.accent-text { color: var(--accent); font-weight: 700; }
.truncate {
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fact-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin: 0;
}
.fact {
  padding: 8px 12px;
  border-right: 1px solid color-mix(in srgb, var(--line) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 10%, transparent);
}
.fact:nth-child(4n) { border-right: 0; }
.fact dt {
  margin: 0;
  font-size: 10px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.fact dd {
  margin: 2px 0 0;
  font-size: 12px;
  font-weight: 600;
  word-break: break-all;
}
.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap);
}
.empty-pad { padding: 16px; }
.bot-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  max-height: 260px;
  overflow: auto;
}
.bot-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 8%, transparent);
}
.bot-row:last-child { border-bottom: 0; }
.bot-row:hover { background: var(--accent-dim); }
.bot-avatar {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--line) 30%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, var(--paper-2));
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: var(--font-xs);
  font-family: var(--mono);
  flex-shrink: 0;
}
.bot-body { flex: 1; min-width: 0; }
.bot-name { font-weight: 650; font-size: 12px; }
.bot-sub { font-size: var(--font-xs); color: var(--muted); }
.bot-face {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid color-mix(in srgb, var(--line) 25%, transparent);
}
.online-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}
.online-dot.on { background: var(--green); }
.runtime-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: var(--font-sm);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 8%, transparent);
}
.chip-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.signal-tag.wf {
  background: color-mix(in srgb, var(--cyan) 16%, transparent);
}
.secondary {
  padding: 0;
}
.secondary summary {
  cursor: pointer;
  padding: 10px 12px;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  list-style: none;
  border-bottom: 1px solid transparent;
}
.secondary[open] summary {
  border-bottom-color: color-mix(in srgb, var(--line) 14%, transparent);
}
.secondary summary::-webkit-details-marker { display: none; }
.net-wrap {
  height: 140px;
  padding: 8px 12px;
}
.net-wrap canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.proc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.proc-table th,
.proc-table td {
  padding: 5px 12px;
  text-align: left;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 10%, transparent);
}
.proc-table th {
  font-size: var(--font-xs);
  color: var(--muted);
  font-family: var(--mono);
  font-weight: 600;
}
.proc-table .name { font-weight: 600; }
.proc-table .warn { color: var(--red); font-weight: 700; }
.proc-table .center { text-align: center; padding: 10px; }
.disk-list,
.iface-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.disk-top {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-xs);
  margin-bottom: 4px;
}
.mini-bar {
  height: 3px;
  background: color-mix(in srgb, var(--line) 12%, transparent);
  overflow: hidden;
  margin-bottom: 3px;
}
.mini-bar i { display: block; height: 100%; }
.disk-sub { font-size: var(--font-xs); color: var(--muted); }
.iface-row {
  display: grid;
  grid-template-columns: minmax(72px, 0.7fr) 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 6px 0;
  font-size: var(--font-xs);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 8%, transparent);
}

@media (max-width: 900px) {
  .metrics-row { grid-template-columns: 1fr 1fr; }
  .fact-row { grid-template-columns: 1fr 1fr; }
  .split { grid-template-columns: 1fr; }
}
.home-page.is-mobile-page .metrics-row { grid-template-columns: 1fr; }
.home-page.is-mobile-page .fact-row { grid-template-columns: 1fr 1fr; }
.home-page.is-mobile-page .net-wrap { height: 110px; }
</style>

