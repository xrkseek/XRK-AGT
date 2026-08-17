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
import HomeTagCloud from '@/components/HomeTagCloud.vue';
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
      <div class="dashboard">
      <div class="dash-head">
        <div>
          <h2 class="dash-title">系统概览</h2>
          <p class="dash-sub">实时监控 · 资源 / 机器人 / 插件工作流</p>
        </div>
        <NButton
          size="tiny"
          type="primary"
          :loading="refreshing"
          @click="load({ force: true })"
        >
          刷新
        </NButton>
      </div>

      <div v-if="staleHint" class="stale-banner" role="status">{{ staleHint }}</div>

      <div class="stats-grid">
        <div
          v-for="s in statCards"
          :key="s.k"
          class="stat-card brutal-card"
          :style="{ '--c': s.c }"
        >
          <div class="stat-label">{{ s.k }}</div>
          <div class="stat-value mono">{{ s.v }}</div>
          <div v-if="s.sub" class="stat-sub">{{ s.sub }}</div>
          <div
            v-if="s.bar != null"
            class="stat-bar"
            role="presentation"
          >
            <i :style="{ width: `${Math.min(100, Math.max(0, s.bar))}%` }" />
          </div>
        </div>
      </div>

      <section class="brutal-card chart-card net-card">
        <header class="card-h">
          <span>网络流量 (KB/s)</span>
          <span class="card-meta">↓ {{ host.rxText }} · ↑ {{ host.txText }}</span>
        </header>
        <div class="net-wrap">
          <canvas id="netChart" ref="netRef" />
        </div>
      </section>

      <div class="info-grid">
        <section class="brutal-card panel">
          <header class="card-h">
            <span>机器人状态</span>
            <span v-if="bots.length" class="card-meta">
              <strong>{{ onlineBots }}</strong>/{{ bots.length }} 在线
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

        <section class="brutal-card panel">
          <header class="card-h">
            <span>插件与工作流</span>
          </header>
          <div class="runtime-sections">
            <section aria-label="插件">
              <div class="sec-label">插件</div>
              <div v-if="pluginMeta.error" class="cloud-empty">{{ pluginMeta.error }}</div>
              <template v-else>
                <div class="cloud-meta" aria-label="插件汇总">
                  <span><strong class="num cyan">{{ pluginMeta.total }}</strong> 总插件</span>
                  <span class="sep">·</span>
                  <span><strong class="num green">{{ pluginMeta.withRules }}</strong> 有规则</span>
                  <span class="sep">·</span>
                  <span><strong class="num yellow">{{ pluginMeta.withTasks }}</strong> 定时</span>
                  <span class="sep">·</span>
                  <span><strong class="num pink mono">{{ pluginMeta.loadTime }}</strong> 加载</span>
                </div>
                <HomeTagCloud
                  v-if="pluginChips.length"
                  tip-prefix="plg"
                  :items="pluginChips"
                />
                <div v-else class="cloud-empty">暂无插件条目</div>
              </template>
            </section>
            <section aria-label="工作流">
              <div class="sec-label">工作流</div>
              <div class="cloud-meta" aria-label="工作流汇总">
                <span>
                  <strong class="num cyan">{{ workflowMeta.enabled }}/{{ workflowMeta.total }}</strong>
                  启用 / 总数
                </span>
              </div>
              <HomeTagCloud
                v-if="workflowChips.length"
                tip-prefix="wf"
                :items="workflowChips"
              />
              <div v-else class="cloud-empty">暂无工作流数据</div>
            </section>
          </div>
        </section>
      </div>

      <div class="bottom-grid">
        <section class="brutal-card panel">
          <header class="card-h">
            <span>进程 Top 5</span>
          </header>
          <table class="proc-table">
            <thead>
              <tr>
                <th>进程名</th>
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
                <td class="mono" :class="{ warn: procWarn(p.cpu) }">
                  {{ Number(p.cpu || 0).toFixed(1) }}%
                </td>
                <td class="mono" :class="{ warn: procWarn(p.mem) }">
                  {{ Number(p.mem || 0).toFixed(1) }}%
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="brutal-card panel">
          <header class="card-h">
            <span>主机信息</span>
            <span class="card-meta mono truncate" :title="host.cpuModel">{{ host.cpuModel }}</span>
          </header>
          <dl class="fact-grid">
            <div v-for="f in hostFacts" :key="f.k" class="fact">
              <dt>{{ f.k }}</dt>
              <dd class="mono">{{ f.v }}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div class="bottom-grid detail-grid">
        <section class="brutal-card panel">
          <header class="card-h">
            <span>磁盘分卷</span>
            <span class="card-meta">{{ disks.length || 0 }} 卷</span>
          </header>
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
          <div v-else class="empty-pad"><NEmpty description="暂无磁盘数据" size="small" /></div>
        </section>

        <section class="brutal-card panel">
          <header class="card-h">
            <span>网络接口</span>
            <span class="card-meta">↓{{ host.rxText }} ↑{{ host.txText }}</span>
          </header>
          <ul v-if="ifaces.length" class="iface-list">
            <li v-for="n in ifaces" :key="n.name" class="iface-row">
              <strong>{{ n.name }}</strong>
              <span class="mono">{{ n.address }}</span>
              <span class="mono muted">{{ n.mac }}</span>
            </li>
          </ul>
          <div v-else class="empty-pad"><NEmpty description="暂无外网接口" size="small" /></div>
        </section>
      </div>
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
}
.dashboard {
  display: flex;
  flex-direction: column;
  gap: var(--section-gap);
  padding-bottom: 10px;
}
.dash-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.dash-title {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.dash-sub {
  margin: 2px 0 0;
  font-size: var(--font-xs);
  color: var(--muted);
}
.stale-banner {
  margin: 0 0 var(--gap);
  padding: 8px 12px;
  font-size: var(--font-xs);
  color: #7a3b00;
  background: #fff3d6;
  border: 1px solid #f0c36d;
  border-radius: 6px;
}
html.dark .stale-banner {
  color: #ffd89a;
  background: rgba(240, 195, 109, 0.12);
  border-color: rgba(240, 195, 109, 0.35);
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--gap);
  flex-shrink: 0;
}
.stat-card {
  position: relative;
  padding: 8px 10px 10px;
  background: color-mix(in srgb, var(--c) 26%, var(--card));
  overflow: hidden;
}
.stat-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--c);
  border-right: 1.5px solid var(--ink);
}
.stat-label {
  font-size: var(--font-xs);
  font-weight: 700;
  opacity: 0.72;
  margin-bottom: 3px;
  letter-spacing: 0.03em;
  padding-left: 4px;
}
.stat-value {
  font-size: 17px;
  font-weight: 800;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  padding-left: 4px;
}
.stat-sub {
  margin-top: 3px;
  padding-left: 4px;
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.3;
  word-break: break-all;
}
.stat-bar {
  margin-top: 7px;
  margin-left: 4px;
  height: 5px;
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  overflow: hidden;
}
.stat-bar i {
  display: block;
  height: 100%;
  background: var(--c);
  border-radius: inherit;
  transition: width 280ms ease;
}
.chart-grid {
  display: grid;
  grid-template-columns: 1fr 1.15fr;
  gap: var(--gap);
}
.net-card {
  flex-shrink: 0;
}
.chart-card {
  padding: 0;
  min-height: 0;
  overflow: hidden;
}
.card-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 800;
  margin: 0;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--paper-2) 55%, var(--card));
  border-bottom: 2px solid var(--ink);
}
.card-meta {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--muted);
}
.card-meta strong {
  color: var(--green);
  font-size: 12px;
}
.dual {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 8px 10px 10px;
}
.chart-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.chart-item-label {
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--muted);
}
.doughnut-wrap {
  width: 100px;
  height: 100px;
}
.doughnut-wrap canvas,
.net-wrap canvas {
  display: block;
  width: 100% !important;
  height: 100% !important;
}
.net-wrap {
  height: 160px;
  position: relative;
  padding: 6px 10px 10px;
}
.info-grid {
  display: grid;
  grid-template-columns: 0.9fr 1.25fr;
  gap: var(--gap);
  align-items: stretch;
}
.bottom-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: var(--gap);
  align-items: stretch;
}
.detail-grid {
  grid-template-columns: 1fr 1fr;
}
.fact-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
  margin: 0;
  padding: 8px 10px 10px;
}
.fact {
  min-width: 0;
  padding: 5px 6px;
  border: 1.5px solid color-mix(in srgb, var(--ink) 18%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--paper-2) 35%, var(--card));
}
.fact dt {
  margin: 0;
  font-size: var(--font-xs);
  font-weight: 700;
  color: var(--muted);
}
.fact dd {
  margin: 2px 0 0;
  font-size: 12px;
  font-weight: 700;
  word-break: break-all;
}
.mini-bar {
  margin: 0 10px 8px;
  height: 7px;
  border: 1.5px solid var(--ink);
  border-radius: 999px;
  background: color-mix(in srgb, var(--card) 70%, transparent);
  overflow: hidden;
}
.mini-bar.swap {
  margin-top: -2px;
}
.mini-bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
}
.disk-list,
.iface-list {
  list-style: none;
  margin: 0;
  padding: 6px 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.disk-row .disk-top {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-xs);
  margin-bottom: 4px;
}
.disk-row .mini-bar {
  margin: 0 0 3px;
}
.disk-sub {
  font-size: var(--font-xs);
  color: var(--muted);
}
.iface-row {
  display: grid;
  grid-template-columns: minmax(72px, 0.7fr) 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 6px 7px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--cyan) 12%, var(--card));
  font-size: var(--font-xs);
}
.iface-row .muted {
  color: var(--muted);
  font-size: var(--font-xs);
}
.truncate {
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.panel > .bot-list,
.panel > .runtime-sections,
.panel > .proc-table,
.panel > .empty-pad {
  padding: 6px 10px 10px;
}
.empty-pad {
  padding: 14px 0;
}
.bot-list {
  list-style: none;
  margin: 0;
  max-height: 240px;
  overflow: auto;
}
.bot-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-bottom: 1.5px solid color-mix(in srgb, var(--ink) 12%, transparent);
  transition: background 100ms ease;
}
.bot-row:last-child {
  border-bottom: none;
}
.bot-row:hover {
  background: color-mix(in srgb, var(--yellow) 22%, transparent);
  border-radius: 6px;
}
.bot-avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1.5px solid var(--ink);
  background: color-mix(in srgb, var(--pink) 28%, var(--paper-2));
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: var(--font-xs);
  flex-shrink: 0;
  box-shadow: 1px 1px 0 var(--ink);
}
.bot-body {
  flex: 1;
  min-width: 0;
}
.bot-name {
  font-weight: 700;
  font-size: 12px;
  line-height: 1.2;
}
.bot-sub {
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.35;
  white-space: normal;
  word-break: break-word;
}
.bot-face {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid var(--ink);
  flex-shrink: 0;
}
.online-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
  border: 1.5px solid var(--ink);
}
.online-dot.on {
  background: var(--green);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--green) 35%, transparent);
}
.runtime-sections {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sec-label {
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink);
  margin-bottom: 3px;
  padding: 2px 0 2px 6px;
  border-left: 3px solid var(--cyan);
}
.cloud-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 5px;
  font-size: var(--font-xs);
  color: var(--muted);
  margin-bottom: 4px;
}
.cloud-meta .num {
  font-weight: 800;
  font-size: 12px;
  margin-right: 1px;
}
.num.cyan { color: var(--cyan); }
.num.green { color: var(--green); }
.num.yellow { color: color-mix(in srgb, var(--yellow) 70%, var(--ink)); }
.num.pink { color: var(--pink); }
.sep { opacity: 0.4; }
.cloud-empty {
  font-size: var(--font-xs);
  color: var(--muted);
  padding: 4px 0;
}
.proc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.proc-table th,
.proc-table td {
  padding: 5px 8px;
  text-align: left;
  border-bottom: 1.5px solid color-mix(in srgb, var(--ink) 12%, transparent);
}
.proc-table th {
  font-size: var(--font-xs);
  color: var(--muted);
  font-weight: 700;
  background: color-mix(in srgb, var(--paper-2) 40%, transparent);
}
.proc-table tbody tr:hover td {
  background: color-mix(in srgb, var(--cyan) 12%, transparent);
}
.proc-table .name {
  font-weight: 600;
}
.proc-table .warn {
  color: var(--red);
  font-weight: 700;
}
.proc-table .muted {
  color: var(--muted);
}
.proc-table .center {
  text-align: center;
  padding: 10px;
}

@media (max-width: 980px) {
  .stats-grid {
    grid-template-columns: 1fr 1fr;
  }
  .chart-grid,
  .info-grid,
  .bottom-grid {
    grid-template-columns: 1fr;
  }
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
@media (min-width: 981px) and (max-width: 1200px) {
  .detail-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.home-page.is-mobile-page .stats-grid {
  grid-template-columns: 1fr;
}
.home-page.is-mobile-page .chart-grid,
.home-page.is-mobile-page .info-grid,
.home-page.is-mobile-page .bottom-grid,
.home-page.is-mobile-page .detail-grid {
  grid-template-columns: 1fr;
}
.home-page.is-mobile-page .doughnut-wrap {
  width: 72px;
  height: 72px;
}
.home-page.is-mobile-page .net-wrap {
  height: 110px;
}
.home-page.is-mobile-page .stat-value {
  font-size: 15px;
}
</style>
