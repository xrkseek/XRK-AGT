/**
 * SystemContext 轻量版（对齐 opencode：多源独立快照 + 稳定 baseline）。
 * 不引入 Effect：用 fingerprint 判断 Unchanged，命中则复用已渲染文本（利于 prompt cache）。
 */
import { createHash } from 'node:crypto';

type GenerationEntry = {
  fingerprint: string;
  text: string;
  updatedAt: number;
};

const generations = new Map<string, GenerationEntry>();
const MAX = 64;

export type ContextSourceRender = {
  key: string;
  fingerprint: string;
  text: string;
};

export function reconcileSystemContext(
  sessionKey: string,
  sources: ContextSourceRender[],
): { text: string; unchanged: boolean; fingerprint: string } {
  const key = String(sessionKey || 'default');
  const list = Array.isArray(sources) ? sources.filter((s) => s && s.text) : [];
  const fp = createHash('sha256');
  fp.update('xrk-system-context-v1\n');
  for (const s of list) {
    fp.update(String(s.key || ''));
    fp.update('\0');
    fp.update(String(s.fingerprint || ''));
    fp.update('\n');
  }
  const fingerprint = `sha256:${fp.digest('hex')}`;
  const prev = generations.get(key);
  if (prev && prev.fingerprint === fingerprint) {
    return { text: prev.text, unchanged: true, fingerprint };
  }

  const text = list
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  generations.set(key, { fingerprint, text, updatedAt: Date.now() });
  if (generations.size > MAX) {
    const oldest = [...generations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k] of oldest.slice(0, generations.size - MAX)) generations.delete(k);
  }
  return { text, unchanged: false, fingerprint };
}

export function clearSystemContextGeneration(sessionKey?: string): void {
  if (!sessionKey) {
    generations.clear();
    return;
  }
  generations.delete(String(sessionKey));
}
