/**
 * 设备工具函数模块
 * 提供设备管理相关的通用工具函数
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import RuntimeUtil from '#utils/runtime-util.js';

/**
 * 初始化目录
 */
export async function initializeDirectories(directories: string[] | null | undefined): Promise<void> {
  if (!Array.isArray(directories) || directories.length === 0) return;
  await Promise.all(
    [...new Set(directories.filter(Boolean))].map((dir) => RuntimeUtil.mkdir(dir)),
  );
}

/**
 * 验证设备注册数据
 */
export function validateDeviceRegistration(
  deviceData: { device_id?: unknown; device_type?: unknown } | null | undefined,
): { valid: boolean; error?: string } {
  if (!deviceData?.device_id) {
    return { valid: false, error: '缺少device_id' };
  }

  if (!deviceData.device_type) {
    return { valid: false, error: '缺少device_type' };
  }

  return { valid: true };
}

/**
 * 生成唯一的命令ID
 */
export function generateCommandId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 检查设备是否具有某个能力
 */
export function hasCapability(
  device: { capabilities?: string[] } | null | undefined,
  capability: string,
): boolean {
  return Boolean(device?.capabilities?.includes(capability));
}

type AudioFileInfo = {
  filename: string;
  session_id: string;
  device_id: string;
  size: number;
  created_at: Date;
  path: string;
};

/**
 * 获取音频文件列表
 */
export async function getAudioFileList(
  directory: string,
  deviceId: string | null = null,
): Promise<AudioFileInfo[]> {
  try {
    const files = await fs.readdir(directory);
    const recordings = await Promise.all(
      files
        .filter((filename) => filename.endsWith('.wav') && (!deviceId || filename.startsWith(deviceId)))
        .map(async (filename) => {
          const filepath = path.join(directory, filename);
          const stats = await fs.stat(filepath).catch(() => null);
          if (!stats) return null;

          const parts = filename.replace('.wav', '').split('_');
          return {
            filename,
            session_id: parts[1] || 'unknown',
            device_id: parts[0]!,
            size: stats.size,
            created_at: stats.birthtime,
            path: filepath,
          } satisfies AudioFileInfo;
        }),
    );

    return recordings
      .filter((r): r is AudioFileInfo => Boolean(r))
      .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  } catch {
    return [];
  }
}
