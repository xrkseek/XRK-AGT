/**
 * Markdown + Mermaid（对齐原 markdown.js；mermaid 与 chart.js 同为正式依赖）
 */
import { marked } from 'marked';
import mermaid from 'mermaid';
import { copyText, downloadBlob, randomId } from '@/utils/http';

marked.setOptions({
  gfm: true,
  breaks: true,
});

let mermaidInited = false;

function ensureMermaid(): void {
  if (mermaidInited) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'neutral',
  });
  mermaidInited = true;
}

export function renderMarkdown(text: unknown): string {
  try {
    return marked.parse(String(text || ''), { async: false });
  } catch {
    return escapeHtml(String(text || ''));
  }
}

export function escapeHtml(s: unknown): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serializeSvg(svgEl: SVGElement | null | undefined): string {
  if (!svgEl) return '';
  const clone = svgEl.cloneNode(true) as SVGElement;
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  return new XMLSerializer().serializeToString(clone);
}

function flashBtn(
  btn: HTMLButtonElement | null | undefined,
  okText: string,
  failText: string,
  ok: boolean,
): void {
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = ok ? okText : failText;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = prev;
    btn.disabled = false;
  }, 1200);
}

/**
 * SVG → PNG Blob（scale 提升清晰度；失败则抛错）
 * @param {SVGElement} svgEl
 * @param {number} [scale=2]
 * @returns {Promise<Blob>}
 */
export function svgToPngBlob(svgEl: SVGElement, scale = 2): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (!svgEl) {
      reject(new Error('无 SVG'));
      return;
    }
    const xml = serializeSvg(svgEl);
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const w = Math.max(1, img.naturalWidth || svgEl.clientWidth || 800);
        const h = Math.max(1, img.naturalHeight || svgEl.clientHeight || 600);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 不可用'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (!blob) reject(new Error('PNG 导出失败'));
            else resolve(blob);
          },
          'image/png',
        );
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 预览加载失败'));
    };
    img.src = url;
  });
}

function wireMermaidToolbar(wrap: HTMLElement, src: string): void {
  const bar = document.createElement('div');
  bar.className = 'chat-mermaid-bar';
  bar.innerHTML = [
    '<button type="button" class="mmd-act" data-act="copy-src" title="复制 Mermaid 源码">复制源码</button>',
    '<button type="button" class="mmd-act" data-act="copy-svg" title="复制 SVG 标记">复制 SVG</button>',
    '<button type="button" class="mmd-act" data-act="dl-svg" title="下载 SVG 文件">下载 SVG</button>',
    '<button type="button" class="mmd-act" data-act="dl-png" title="下载 PNG 图片">下载 PNG</button>',
  ].join('');

  const canvas = document.createElement('div');
  canvas.className = 'chat-mermaid-canvas';
  while (wrap.firstChild) canvas.appendChild(wrap.firstChild);
  wrap.appendChild(bar);
  wrap.appendChild(canvas);

  bar.addEventListener('click', async (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('[data-act]');
    if (!(btn instanceof HTMLButtonElement)) return;
    const act = btn.dataset.act;
    const svgEl = canvas.querySelector('svg') as SVGElement | null;
    const stamp = Date.now();
    try {
      if (act === 'copy-src') {
        const ok = await copyText(src);
        flashBtn(btn, '已复制', '复制失败', ok);
        return;
      }
      if (act === 'copy-svg') {
        const xml = serializeSvg(svgEl);
        const ok = xml ? await copyText(xml) : false;
        flashBtn(btn, '已复制', '复制失败', ok);
        return;
      }
      if (act === 'dl-svg') {
        const xml = serializeSvg(svgEl);
        if (!xml) throw new Error('无 SVG');
        downloadBlob(
          new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }),
          `mermaid-${stamp}.svg`,
        );
        flashBtn(btn, '已下载', '失败', true);
        return;
      }
      if (act === 'dl-png') {
        if (!svgEl) throw new Error('无 SVG');
        const blob = await svgToPngBlob(svgEl, 2);
        downloadBlob(blob, `mermaid-${stamp}.png`);
        flashBtn(btn, '已下载', '失败', true);
      }
    } catch {
      flashBtn(btn, '已完成', '失败', false);
    }
  });
}

/** 在容器内渲染 ```mermaid 代码块 */
export async function renderMermaidIn(root: HTMLElement | null | undefined): Promise<void> {
  if (!root) return;
  const blocks = root.querySelectorAll('pre code.language-mermaid, code.language-mermaid');
  if (!blocks.length) return;
  ensureMermaid();
  for (const code of blocks) {
    const pre = code.closest('pre') || code.parentElement;
    if (!pre || pre.dataset.mermaidDone === '1') continue;
    const src = code.textContent || '';
    if (!src.trim()) continue;
    const id = randomId('mmd');
    try {
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement('div');
      wrap.className = 'chat-mermaid';
      wrap.innerHTML = svg;
      wireMermaidToolbar(wrap, src);
      pre.replaceWith(wrap);
      wrap.dataset.mermaidDone = '1';
    } catch (err) {
      const errEl = document.createElement('div');
      errEl.className = 'chat-mermaid-error';
      errEl.textContent = `Mermaid 渲染失败: ${(err as Error)?.message || err}`;
      pre.after(errEl);
      pre.dataset.mermaidDone = '1';
    }
  }
}

export async function downloadImage(url: string): Promise<void> {
  if (!url) throw new Error('无图片地址');
  const name = `image-${Date.now()}.png`;
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    downloadBlob(url, name);
    return;
  }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(res.statusText || '下载失败');
  const blob = await res.blob();
  downloadBlob(blob, name);
}
