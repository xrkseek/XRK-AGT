/**
 * NapCat file 段：路径判定与内联二进制还原（入站词条 / 出站 stat 共用）
 */

/** 是否像本地文件路径（排除二进制误填进 file 段） */
export function isPathLike(filePath: unknown): boolean {
  if (filePath == null || typeof filePath !== 'string') return false;
  const s = filePath.trim();
  if (!s || s.length > 4096) return false;
  const head = s.slice(0, 12);
  if (
    head.startsWith('GIF8')
    || head.startsWith('\x89PNG')
    || head.startsWith('RIFF')
    || head.startsWith('\xFF\xD8\xFF')
    || head.startsWith('PK\u0003')
  ) return false;
  for (let i = 0; i < Math.min(s.length, 256); i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) return false;
  }
  if (/^file:\/\//i.test(s)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
  if (s.includes('/') || s.includes('\\')) return true;
  if (/^[\w{}.+-]+\.(jpg|jpeg|png|gif|webp|bmp|mp4|amr|silk|ogg|bin)$/i.test(s)) return true;
  return false;
}

/** file 段误存为二进制串时还原 Buffer */
export function inlineBinaryFromRef(ref: unknown): Buffer | null {
  if (typeof ref !== 'string') return null;
  const s = ref;
  if (s.length < 12 || s.startsWith('base64://') || /^https?:\/\//i.test(s.trim())) return null;
  if (isPathLike(s)) return null;
  const head = s.slice(0, 12);
  if (
    head.startsWith('GIF8')
    || head.startsWith('\x89PNG')
    || head.startsWith('RIFF')
    || head.startsWith('\xFF\xD8\xFF')
  ) {
    return Buffer.from(s, 'latin1');
  }
  return null;
}
