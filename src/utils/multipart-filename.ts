/**
 * multer/busboy 将 Content-Disposition 文件名按 Latin-1 解码；
 * 浏览器实际发送的是 UTF-8 字节 → 中文变成 å¹´ 一类乱码。
 * 仅当 latin1→utf8 可无损回转时才纠正。
 */
export function decodeMulterFilename(name: unknown): string {
  const raw = String(name ?? '').trim();
  if (!raw) return 'file';

  let fixed = raw;
  try {
    const asUtf8 = Buffer.from(raw, 'latin1').toString('utf8');
    if (
      !asUtf8.includes('\uFFFD') &&
      Buffer.from(asUtf8, 'utf8').toString('latin1') === raw
    ) {
      fixed = asUtf8;
    }
  } catch {
    /* keep raw */
  }

  const base = fixed.replace(/\\/g, '/').split('/').pop() || 'file';
  return base.replace(/[\0-\x1f<>:"|?*]/g, '_').slice(0, 200) || 'file';
}
