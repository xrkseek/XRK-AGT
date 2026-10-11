/**
 * Core www 浏览器兼容层（语义权威；随 /xrk 进 git）
 *
 * 路径：`core/system-Core/www/xrk/src/utils/http.ts`
 * 控制台从此处 import；其它产品 Core：**只内联**同语义。
 */

import type { JsonValue, SuccessEnvelope } from '@/types';

export function randomId(prefix = 'id'): string {
  try {
    const uuid = globalThis.crypto?.randomUUID;
    if (typeof uuid === 'function') return uuid.call(globalThis.crypto);
  } catch {
    /* fall through */
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 解包 HttpResponse.success（对象拍平；数组/标量在 data）
 * 权威定义见 `src/infrastructure/http/http-utils.js` 的 `HttpResponse.success`。
 */
export function unwrapSuccess<T = any>(json: SuccessEnvelope<T>): any {
  if (!json?.success) throw new Error(json?.message || '请求失败');
  if (json.data !== undefined) return json.data;
  const { success: _ok, message: _msg, ...rest } = json;
  return rest;
}

export function abortTimeout(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  controller.signal.addEventListener('abort', () => clearTimeout(id), { once: true });
  return controller.signal;
}

export function deepClone<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return (Array.isArray(value) ? value.slice() : { ...value }) as T;
  }
}

export const EMOTION_KEYS = new Set(['happy', 'message', 'think', 'sad', 'angry', 'cool']);

export function normalizeEmotionKey(key: string): string {
  const k = String(key || '').toLowerCase();
  return EMOTION_KEYS.has(k) ? k : 'happy';
}

/**
 * 复制文本到剪贴板。
 * 优先 Clipboard API；在非安全上下文（如 http://公网IP）失败时降级 textarea + execCommand。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (typeof globalThis.navigator?.clipboard?.writeText === 'function') {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* NotAllowedError / insecure context */
  }
  if (typeof document === 'undefined' || !document.body) return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * 触发浏览器下载 Blob / data URL / blob URL。
 */
export function downloadBlob(data: Blob | string, filename = 'download'): void {
  if (typeof document === 'undefined') return;
  let href = '';
  let revoke = false;
  if (typeof data === 'string') {
    href = data;
  } else if (data instanceof Blob) {
    href = URL.createObjectURL(data);
    revoke = true;
  } else {
    return;
  }
  const a = document.createElement('a');
  a.href = href;
  a.download = filename || 'download';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(href), 2000);
}

/** 供 config 字段等 JSON 值流转使用 */
export type { JsonValue };