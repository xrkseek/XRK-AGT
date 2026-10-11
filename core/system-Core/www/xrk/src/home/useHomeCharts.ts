import { onBeforeUnmount, shallowRef, watch } from 'vue';
import {
  ArcElement,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import type { Chart as ChartInstance, ChartItem, Plugin, TooltipItem } from 'chart.js';
import type { Ref } from 'vue';

/** 三个图表的实例容器 */
export interface HomeCharts {
  cpu: ChartInstance<'doughnut', number[], string> | null;
  mem: ChartInstance<'doughnut', number[], string> | null;
  net: ChartInstance<'line', number[], string> | null;
}

export type DoughnutKey = 'cpu' | 'mem';

export interface HomeChartsOptions {
  cpuEl: Ref<HTMLCanvasElement | null>;
  memEl: Ref<HTMLCanvasElement | null>;
  netEl: Ref<HTMLCanvasElement | null>;
  cpu: Ref<number>;
  mem: Ref<number>;
  history: { netRx: number[]; netTx: number[] };
}

function isDoughnutChart(
  value: ChartInstance,
): value is ChartInstance<'doughnut', number[], string> {
  const type = (value.config as { type?: string }).type;
  return type === 'doughnut';
}

/**
 * 遗留：`filter` 在 chart.js v4 属于 tooltip 顶层选项（见 TooltipOptions），
 * 写在 callbacks 里不会被调用。为不改变既有表现，这里保持原对象形状。
 */
function legacyTooltipFilter() {
  return {
    filter(item: TooltipItem<'line'>) {
      return Number(item.parsed.y ?? 0) > 0.01;
    },
  };
}

let registered = false;

function ensureChart() {
  if (registered) return;
  Chart.register(
    ArcElement,
    DoughnutController,
    LineController,
    LineElement,
    PointElement,
    CategoryScale,
    LinearScale,
    Filler,
    Legend,
    Tooltip,
  );
  registered = true;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function themeColors(): Record<string, string> {
  return {
    primary: cssVar('--cyan', '#3ecfff'),
    success: cssVar('--green', '#5ad67d'),
    warning: cssVar('--yellow', '#ffd24a'),
    danger: cssVar('--red', '#ff5a5a'),
    border: cssVar('--ink', '#1a1510'),
    muted: cssVar('--muted', '#6b5e4e'),
    track: cssVar('--paper-2', '#ffe9b8'),
  };
}

function centerLabelPlugin(canvasId: string): Plugin<'doughnut'> {
  return {
    id: `label-${canvasId}`,
    afterDraw(chart) {
      if (!isDoughnutChart(chart) || chart.canvas?.id !== canvasId) return;
      const ctx = chart.ctx;
      const { left, right, top, bottom } = chart.chartArea;
      const value = chart.data.datasets[0].data[0];
      ctx.save();
      const fontFamily = (getComputedStyle(document.body).fontFamily || '').split(',')[0].trim() || 'sans-serif';
      ctx.font = `600 13px ${fontFamily}`;
      ctx.fillStyle = cssVar('--ink', '#1a1510');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Number(value).toFixed(1)}%`, (left + right) / 2, (top + bottom) / 2);
      ctx.restore();
    },
  };
}

/**
 * @param {{ cpuEl: import('vue').Ref<HTMLCanvasElement|null>, memEl: import('vue').Ref<HTMLCanvasElement|null>, netEl: import('vue').Ref<HTMLCanvasElement|null>, cpu: import('vue').Ref<number>, mem: import('vue').Ref<number>, history: { netRx: number[], netTx: number[] } }} opts
 */
export function useHomeCharts(
  opts: HomeChartsOptions,
): { paint: () => void; destroyAll: () => void } {
  const { cpuEl, memEl, netEl, cpu, mem, history } = opts;
  const charts = shallowRef<HomeCharts>({ cpu: null, mem: null, net: null });

  function destroyOne(key: keyof HomeCharts): void {
    const c = charts.value[key];
    if (!c) return;
    try {
      c.destroy();
    } catch {
      /* ignore */
    }
    charts.value = { ...charts.value, [key]: null };
  }

  function destroyAll(): void {
    destroyOne('cpu');
    destroyOne('mem');
    destroyOne('net');
  }

  function ensureDoughnut(
    key: DoughnutKey,
    canvas: HTMLCanvasElement | null,
    value: number,
    color: string,
  ): void {
    if (!canvas) return;
    ensureChart();
    const colors = themeColors();
    const free = Math.max(0, 100 - value);
    const existing = charts.value[key];
    if (existing && existing.canvas !== canvas) {
      destroyOne(key);
    }
    const live = charts.value[key];
    if (!live) {
      const ctx = canvas.getContext('2d') as ChartItem;
      const chart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['使用', '空闲'],
          datasets: [
            {
              data: [value, free],
              backgroundColor: [color, colors.track],
              borderWidth: 0,
            },
          ],
        },
        options: {
          cutout: '72%',
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
        },
        plugins: [centerLabelPlugin(canvas.id)],
      });
      charts.value = { ...charts.value, [key]: chart };
    } else {
      live.data.datasets[0].data = [value, free];
      live.data.datasets[0].backgroundColor = [color, colors.track];
      live.update('none');
    }
  }

  function ensureNet(canvas: HTMLCanvasElement | null): void {
    if (!canvas) return;
    ensureChart();
    const colors = themeColors();
    /** drawBorder 在 chart.js v4 已移除；保留字段以维持原对象形状 */
    const yGrid = { color: `${colors.border}22`, drawBorder: false };
    const labels = history.netRx.map(() => '');
    const existing = charts.value.net;
    if (existing && existing.canvas !== canvas) destroyOne('net');

    if (!charts.value.net) {
      const ctx = canvas.getContext('2d') as ChartItem;
      const chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '下行',
              data: [...history.netRx],
              borderColor: colors.primary,
              backgroundColor: `${colors.primary}22`,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
              borderWidth: 2,
              spanGaps: true,
            },
            {
              label: '上行',
              data: [...history.netTx],
              borderColor: colors.warning,
              backgroundColor: `${colors.warning}22`,
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
              borderWidth: 2,
              spanGaps: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                color: colors.muted,
                padding: 10,
                font: { size: 11 },
                usePointStyle: true,
                pointStyle: 'line',
              },
            },
            tooltip: {
              enabled: true,
              callbacks: {
                label(ctx: TooltipItem<'line'>) {
                  const v = Number(ctx.parsed.y ?? 0);
                  if (v === 0 || v < 0.01) return '';
                  return `${ctx.dataset.label}: ${v.toFixed(2)} KB/s`;
                },
                ...legacyTooltipFilter(),
              },
            },
          },
          scales: {
            x: { display: false, grid: { display: false } },
            y: {
              beginAtZero: true,
              suggestedMax: 10,
              grid: yGrid,
              ticks: { display: false, maxTicksLimit: 5 },
            },
          },
        },
      });
      charts.value = { ...charts.value, net: chart };
      return;
    }

    const net = charts.value.net;
    net.data.labels = labels;
    net.data.datasets[0].data = [...history.netRx];
    net.data.datasets[1].data = [...history.netTx];
    const all = [...history.netRx, ...history.netTx].filter((v) => Number.isFinite(v) && v > 0);
    const maxValue = Math.max(...all, 1);
    if (net.options.scales?.y) {
      net.options.scales.y.max = Math.ceil(maxValue * 1.2);
    }
    net.update('none');
  }

  function paint(): void {
    const colors = themeColors();
    const c = Number(cpu.value) || 0;
    const m = Number(mem.value) || 0;
    const cpuColor = c > 80 ? colors.danger : c > 50 ? colors.warning : colors.primary;
    const memColor = m > 80 ? colors.danger : m > 50 ? colors.warning : colors.success;
    ensureDoughnut('cpu', cpuEl.value, c, cpuColor);
    ensureDoughnut('mem', memEl.value, m, memColor);
    ensureNet(netEl.value);
  }

  watch([cpu, mem, () => history.netRx.length, () => history.netTx.at(-1)], () => {
    requestAnimationFrame(paint);
  });

  onBeforeUnmount(destroyAll);

  return { paint, destroyAll };
}
