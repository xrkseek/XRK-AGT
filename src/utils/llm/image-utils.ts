/**
 * 图片 / 多模态辅助工具：
 * - 统一将相对路径 / 内部 URL 转成可 fetch 的绝对 URL
 * - 统一下载图片并转为 base64（含 QQ file 哈希：经 entry-media + bot.sendApi get_image）
 * - 可选：在 OpenAI 风格 messages 上，把 image_url.url 统一转为 data URL
 */

import { readImageBuffer } from '#utils/entry-media.js';
import { getWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';
import { decodeHtmlEntitiesInUrl } from '#utils/llm/vision-content.js';

export { decodeHtmlEntitiesInUrl } from '#utils/llm/vision-content.js';

const DATA_URL_CACHE = new Map();

function getServerPublicUrl(): string {
  try {
    const base = (globalThis as any).AgentRuntime?.url;
    return base ? String(base).replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function normalizeToAbsoluteUrl(url: any) {
  const u = decodeHtmlEntitiesInUrl(url);
  if (!u) return '';
  if (u.startsWith('data:')) return u;
  if (/^https?:\/\//i.test(u)) return u;

  const base = getServerPublicUrl();
  if (base && u.startsWith('/')) return `${base}${u}`;
  return u;
}

function parseDataUrl(dataUrl: any) {
  const raw = String(dataUrl ?? '').trim();
  const m = raw.match(/^data:([^;]+);base64,(.*)$/i);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

function resolveVisionSendApi(options: any = {}) {
  if (typeof options.sendApi === 'function') return options.sendApi;
  const e: any = getWorkflowRequestContext()?.e;
  if (e?.bot && typeof e.bot.sendApi === 'function') {
    return (action: any, params: any) => e.bot.sendApi(action, params);
  }
  return null;
}

function bufferToVisionPayload(buf: any, fallbackMime = 'image/png') {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  const mimeType = fallbackMime || 'image/png';
  const b = buf as Buffer & { toBase64?: () => string };
  return {
    mimeType,
    base64: typeof b.toBase64 === 'function' ? b.toBase64() : buf.toString('base64'),
  };
}

/**
 * 下载图片并返回 { mimeType, base64 }
 * - data URL：直接解析
 * - http(s)：原生 fetch
 * - QQ file 哈希 / 本地路径 / CDN：readImageBuffer + 可选 get_image
 */
export async function fetchAsBase64(url: any, { timeoutMs = 30000, sendApi }: any = {}) {
  const raw = decodeHtmlEntitiesInUrl(url);
  if (!raw) return null;

  if (raw.startsWith('data:')) {
    const parsed = parseDataUrl(raw);
    return parsed && parsed.base64 ? parsed : null;
  }

  const abs = normalizeToAbsoluteUrl(raw);
  if (/^https?:\/\//i.test(abs)) {
    const now = Date.now();
    const cached = DATA_URL_CACHE.get(abs);
    if (cached && now - cached.ts < 5 * 60 * 1000) {
      return { mimeType: cached.mimeType, base64: cached.base64 };
    }

    try {
      const resp = await fetch(abs, { signal: AbortSignal.timeout(timeoutMs) });
      if (resp.ok) {
        const mimeType = resp.headers.get('content-type') || 'image/png';
        const u8 = new Uint8Array(await resp.arrayBuffer());
        const base64 = Buffer.from(u8).toString('base64');
        DATA_URL_CACHE.set(abs, { ts: now, mimeType, base64 });
        return { mimeType, base64 };
      }
    } catch {
      /* fall through to entry-media（QQ CDN 等常需 get_image） */
    }
  }

  const api = resolveVisionSendApi({ sendApi });
  const buf = await readImageBuffer({ file: raw, url: abs || raw }, api, {
    fetchTimeout: timeoutMs,
    getImageTimeout: timeoutMs
  });
  return bufferToVisionPayload(buf);
}

/**
 * 在 OpenAI 风格 messages 上，把 user 消息中的 image_url.url 统一转成 data URL
 * @param {Array} messages - OpenAI Chat Completions 风格的 messages
 */
export async function ensureMessagesImagesDataUrl(messages: any, { timeoutMs = 30000, sendApi }: any = {}) {
  if (!Array.isArray(messages)) return;

  for (const msg of messages) {
    if (!msg || msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (!part || part.type !== 'image_url' || !part.image_url?.url) continue;

      const info = await fetchAsBase64(part.image_url.url, { timeoutMs, sendApi });
      if (!info || !info.base64) continue;

      part.image_url.url = `data:${info.mimeType};base64,${info.base64}`;
    }
  }
}
