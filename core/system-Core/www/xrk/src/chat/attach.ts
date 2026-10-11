/**
 * 聊天附件：压缩 / base64 / 预览项（对齐原 compressImageFile + fileToBase64）
 */
import { randomId } from '@/utils/http';

export interface CompressImageOptions {
  maxDimension?: number;
  quality?: number;
}

/** 待发送附件 */
export interface AttachItem {
  id: string;
  file: File;
  name: string;
  type: string;
  size: number;
  isImage: boolean;
  previewUrl: string;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 简单压缩：canvas 缩放到 maxDimension */
export async function compressImageFile(
  file: File,
  { maxDimension = 1280, quality = 0.82 }: CompressImageOptions = {},
): Promise<File> {
  if (!file?.type?.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size < 900 * 1024) {
      bitmap.close?.();
      return file;
    }
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return file;
    return new File([blob], (file.name || 'image').replace(/\.\w+$/, '.jpg'), {
      type: 'image/jpeg',
    });
  } catch {
    return file;
  }
}

export function createAttachItem(file: File): AttachItem {
  const id = randomId('att');
  const isImage = file.type?.startsWith('image/');
  const previewUrl = isImage ? URL.createObjectURL(file) : '';
  return {
    id,
    file,
    name: file.name || 'file',
    type: file.type || '',
    size: file.size || 0,
    isImage: Boolean(isImage),
    previewUrl,
  };
}

export function revokeAttachItem(item: Partial<AttachItem> | null | undefined): void {
  if (item?.previewUrl?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      /* ignore */
    }
  }
}

export function formatBytes(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}
