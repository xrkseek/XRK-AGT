// @ts-nocheck
import os from 'node:os';
import si from 'systeminformation';
import runtimeConfig from '#infrastructure/config/config.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { collectBotInventory, summarizeBots } from '#infrastructure/http/utils/botInventory.js';
import { readDisks, readMem, readNetworkBytes } from '#infrastructure/http/utils/system-metrics.js';
import { getAuthModePublicSnapshot } from '#infrastructure/http/runtime-auth.js';
import { HttpResponse } from '#utils/http-utils.js';

let __lastNetSample = null;
let __netSampler = null;
const __netHist = [];
const __netRecent = [];
const NET_HISTORY_LIMIT = 24 * 60;
const NET_RECENT_LIMIT = 60;
const NET_SAMPLE_MS = 3_000;
const NET_MAX_BPS = 10 * 1024 * 1024 * 1024;

let __cpuCache = { percent: 0, ts: 0 };
let __cpuTimer = null;
let __cpuPrevSnap = null;
let __fsCache = { disks: [], ts: 0 };
let __procCache = { top5: [], ts: 0 };
let __fsTimer = null;
let __procTimer = null;

function __sampleCpuOnce() {
  try {
    const cpus = os.cpus();
    if (!cpus?.length) return;
    if (!__cpuPrevSnap) {
      __cpuPrevSnap = cpus;
      return;
    }
    let idleDelta = 0;
    let totalDelta = 0;
    for (let i = 0; i < cpus.length; i++) {
      const t1 = __cpuPrevSnap[i].times;
      const t2 = cpus[i].times;
      const idle = Math.max(0, t2.idle - t1.idle);
      const total = Math.max(
        0,
        (t2.user - t1.user) + (t2.nice - t1.nice) + (t2.sys - t1.sys) + (t2.irq - t1.irq) + idle
      );
      idleDelta += idle;
      totalDelta += total;
    }
    __cpuPrevSnap = cpus;
    if (totalDelta > 0) {
      __cpuCache = {
        percent: +(((totalDelta - idleDelta) / totalDelta) * 100).toFixed(2),
        ts: Date.now(),
      };
    }
  } catch { /* ignore */ }
}

async function __sampleNetOnce() {
  try {
    const now = Date.now();
    let { rx, tx } = await readNetworkBytes();
    if (__lastNetSample && (rx < __lastNetSample.rx * 0.5 || tx < __lastNetSample.tx * 0.5)) {
      rx = __lastNetSample.rx;
      tx = __lastNetSample.tx;
    }

    if (__lastNetSample) {
      const dt = Math.max(0.1, (now - __lastNetSample.ts) / 1000);
      const rxDelta = rx - __lastNetSample.rx;
      const txDelta = tx - __lastNetSample.tx;
      let rxSec = rxDelta >= 0 ? rxDelta / dt : (__netRecent.at(-1)?.rxSec || 0);
      let txSec = txDelta >= 0 ? txDelta / dt : (__netRecent.at(-1)?.txSec || 0);
      if (rxSec > NET_MAX_BPS || txSec > NET_MAX_BPS) {
        rxSec = __netRecent.at(-1)?.rxSec || 0;
        txSec = __netRecent.at(-1)?.txSec || 0;
      }
      __netRecent.push({ ts: now, rxSec, txSec });
      if (__netRecent.length > NET_RECENT_LIMIT) __netRecent.shift();

      const tsMin = Math.floor(now / 60000) * 60000;
      if (rxSec > 0 || txSec > 0) {
        const last = __netHist.at(-1);
        if (last?.ts === tsMin) {
          last.rxSec = Math.max(last.rxSec, rxSec);
          last.txSec = Math.max(last.txSec, txSec);
        } else {
          __netHist.push({ ts: tsMin, rxSec, txSec });
          if (__netHist.length > NET_HISTORY_LIMIT) __netHist.shift();
        }
      }
    }
    __lastNetSample = { ts: now, rx, tx };
  } catch { /* ignore */ }
}

function __ensureNetSampler() {
  if (__netSampler) return;
  void __sampleNetOnce();
  __netSampler = setInterval(__sampleNetOnce, NET_SAMPLE_MS);
}

function __getNetHistory24h() {
  const start = Date.now() - 24 * 60 * 60 * 1000;
  return __netHist.filter((p) => p.ts >= start).slice(-NET_HISTORY_LIMIT);
}

function __getNetRecent() {
  if (__netRecent.length >= NET_RECENT_LIMIT) return __netRecent.slice(-NET_RECENT_LIMIT);
  const out = [...__netRecent];
  const last = out.at(-1) || { rxSec: 0, txSec: 0 };
  const now = Date.now();
  while (out.length < NET_RECENT_LIMIT) {
    out.unshift({
      ts: now - (NET_RECENT_LIMIT - out.length) * NET_SAMPLE_MS,
      rxSec: last.rxSec,
      txSec: last.txSec,
    });
  }
  return out.slice(-NET_RECENT_LIMIT);
}

async function __refreshFsCache() {
  try {
    __fsCache = { disks: await readDisks(), ts: Date.now() };
  } catch { /* ignore */ }
}

async function __refreshProcCache() {
  try {
    const list = (await si.processes().catch(() => ({ list: [] })))?.list || [];
    __procCache = {
      top5: list
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          cpu: Number(p.pcpu || p.cpu || 0),
          mem: Number(p.pmem || p.mem || 0),
        }))
        .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
        .slice(0, 5),
      ts: Date.now(),
    };
  } catch { /* ignore */ }
}

function __ensureSysSamplers() {
  if (!__fsTimer) {
    void __refreshFsCache();
    __fsTimer = setInterval(() => void __refreshFsCache(), 30_000);
  }
  if (!__procTimer) {
    void __refreshProcCache();
    __procTimer = setInterval(() => void __refreshProcCache(), 10_000);
  }
  if (!__cpuTimer) {
    __cpuPrevSnap = os.cpus();
    setTimeout(__sampleCpuOnce, 600);
    __cpuTimer = setInterval(__sampleCpuOnce, 2_000);
  }
}

function __ipv4Ifaces() {
  const out = {};
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    const iface = (list || []).find((i) => i.family === 'IPv4' && !i.internal);
    if (iface) out[name] = { address: iface.address, netmask: iface.netmask, mac: iface.mac };
  }
  return out;
}

async function buildSystemSnapshot(AgentRuntime, { includeHistory = false } = {}) {
  if (!__cpuCache.ts || Date.now() - __cpuCache.ts > 5_000) __sampleCpuOnce();

  const cpus = os.cpus();
  const mem = await readMem();
  const memUsage = process.memoryUsage();
  const lastNet = __lastNetSample || { rx: 0, tx: 0 };
  let rxSec = 0;
  let txSec = 0;
  if (__netRecent.length) {
    const recent = __netRecent.slice(-3);
    rxSec = recent.reduce((s, p) => s + (p.rxSec || 0), 0) / recent.length;
    txSec = recent.reduce((s, p) => s + (p.txSec || 0), 0) / recent.length;
  } else if (__netHist.length) {
    rxSec = __netHist.at(-1).rxSec || 0;
    txSec = __netHist.at(-1).txSec || 0;
  }
  rxSec = Number.isFinite(rxSec) ? rxSec : 0;
  txSec = Number.isFinite(txSec) ? txSec : 0;

  if (!__fsTimer || Date.now() - (__fsCache.ts || 0) > 60_000) void __refreshFsCache();
  if (!__procTimer || Date.now() - (__procCache.ts || 0) > 20_000) void __refreshProcCache();

  const disks = Array.isArray(__fsCache.disks) ? __fsCache.disks : [];
  const bots = await collectBotInventory(AgentRuntime, { includeDevices: true });
  const workflowStats = AiWorkflowLoader.getStats();
  const workflowList = AiWorkflowLoader.getWorkflowsByPriority().map((stream) => ({
    name: stream.name,
    description: stream.description,
    priority: stream.priority,
    enabled: stream.config?.enabled !== false,
  }));

  const usagePercent = mem.total > 0 ? ((mem.used / mem.total) * 100).toFixed(2) : '0';
  const system = {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    cpu: {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      usage: process.cpuUsage(),
      percent: __cpuCache.percent || 0,
      // Windows 上 os.loadavg() 恒为 [0,0,0]，勿当成真实负载
      loadavg: os.platform() === 'win32' ? null : os.loadavg(),
    },
    memory: {
      total: mem.total,
      free: mem.free,
      used: mem.used,
      usagePercent,
      process: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },
    },
    swap: {
      total: mem.swapTotal,
      used: mem.swapUsed,
      usagePercent: mem.swapTotal ? +((mem.swapUsed / mem.swapTotal) * 100).toFixed(2) : 0,
    },
    disks,
    net: { rxBytes: lastNet.rx || 0, txBytes: lastNet.tx || 0 },
    netRates: { rxSec, txSec },
    netHistory24h: includeHistory ? __getNetHistory24h() : [],
    netRecent: __getNetRecent(),
    network: __ipv4Ifaces(),
  };

  const snapshot = {
    success: true,
    timestamp: Date.now(),
    system,
    bot: {
      url: AgentRuntime.url,
      port: AgentRuntime.actualPort ?? AgentRuntime.httpPort ?? null,
      startTime: AgentRuntime.stat?.start_time || Date.now() / 1000,
      uptime: AgentRuntime.stat?.start_time
        ? Date.now() / 1000 - AgentRuntime.stat.start_time
        : process.uptime(),
    },
    bots,
    processesTop5: Array.isArray(__procCache.top5) ? __procCache.top5 : [],
    taskers: summarizeTaskers(AgentRuntime.tasker),
    workflows: { stats: workflowStats, items: workflowList },
  };
  snapshot.panels = buildPanelPayload(snapshot);
  return snapshot;
}

/** Tasker 实例含 ws/readline/Timer，不可直接 JSON */
function summarizeTaskers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((t) => ({
    id: t?.id ?? null,
    name: t?.name ?? null,
    path: t?.path ?? t?.name ?? null,
  }));
}

function buildPanelPayload(snapshot) {
  const { system, bots, workflows, processesTop5 } = snapshot;
  const disk = system.disks?.[0];
  const diskUsage = disk?.size > 0 ? ((disk.used / disk.size) * 100).toFixed(1) : 0;
  return {
    metrics: {
      cpu: system.cpu.percent || 0,
      memory: Number(system.memory.usagePercent) || 0,
      disk: Number(diskUsage) || 0,
      swap: system.swap.usagePercent || 0,
      net: system.netRates || { rxSec: 0, txSec: 0 },
    },
    bots: summarizeBots(bots),
    workflows: {
      total: workflows.stats.total,
      enabled: workflows.stats.enabled,
      items: workflows.items.slice(0, 5),
    },
    processes: processesTop5 || [],
    interfaces: system.network,
  };
}

export default {
  name: 'core',
  dsc: '核心系统API',
  priority: 200,
  init: async () => {
    __ensureNetSampler();
    __ensureSysSamplers();
  },
  routes: [
    {
      method: 'GET',
      path: '/api/system/auth-mode',
      systemAuth: false,
      handler: HttpResponse.asyncHandler(async (_req, res, AgentRuntime) => {
        return HttpResponse.success(res, getAuthModePublicSnapshot(AgentRuntime));
      }, 'system.auth-mode'),
    },
    {
      method: 'GET',
      path: '/api/system/status',
      handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
        const includeHist =
          ['24h', '1', 'true'].includes(req.query?.hist) ||
          ['1', 'true'].includes(req.query?.withHistory);
        return HttpResponse.json(res, await buildSystemSnapshot(AgentRuntime, { includeHistory: includeHist }));
      }, 'system.status'),
    },
    {
      method: 'GET',
      path: '/api/system/overview',
      handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
        const includeHist =
          ['24h', '1', 'true'].includes(req.query?.hist) ||
          ['1', 'true'].includes(req.query?.withHistory);
        const snapshot = await buildSystemSnapshot(AgentRuntime, { includeHistory: includeHist });
        HttpResponse.success(res, {
          timestamp: snapshot.timestamp,
          system: snapshot.system,
          bot: snapshot.bot,
          panels: snapshot.panels,
          workflows: snapshot.workflows,
          bots: snapshot.bots,
          processesTop5: snapshot.processesTop5,
          taskers: snapshot.taskers,
          network: {
            current: snapshot.system.netRates,
            recent: snapshot.system.netRecent,
            history: snapshot.system.netHistory24h,
          },
        });
      }, 'system.overview'),
    },
    {
      method: 'GET',
      path: '/api/status',
      handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
        const snapshot = await buildSystemSnapshot(AgentRuntime, { includeHistory: false });
        HttpResponse.success(res, {
          system: snapshot.system,
          bot: snapshot.bot,
          bots: snapshot.bots,
          taskers: snapshot.taskers,
        });
      }, 'status'),
    },
    {
      method: 'GET',
      path: '/api/config',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        // 只导出 YAML 缓存；勿整实例（含 HotReload/Timeout）
        return HttpResponse.success(res, {
          config: {
            port: runtimeConfig.port ?? null,
            configs: runtimeConfig.config ?? {},
          },
        });
      }, 'config.snapshot'),
    },
    {
      method: 'GET',
      path: '/api/health',
      handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
        const { buildReadinessSnapshot } = await import('#utils/observability.js');
        const snapshot = await buildReadinessSnapshot({ agentRuntime: AgentRuntime });
        const httpStatus = snapshot.status === 'unhealthy' ? 503 : 200;
        return HttpResponse.json(res, { success: true, ...snapshot }, httpStatus);
      }, 'health'),
    },
  ],
};
