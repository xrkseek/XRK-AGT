import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import paths from '#utils/paths.js';
import { GLOBAL_CONFIGS, isServerOrFactoryConfig } from '#infrastructure/config/config-constants.js';

type SeedLogger = {
  success: (message: string) => Promise<void> | void;
};

export function copyFileIfMissingSync(sourcePath: string, targetPath: string): boolean {
  if (fsSync.existsSync(targetPath)) return false;
  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsSync.copyFileSync(sourcePath, targetPath);
  return true;
}

export async function copyFileIfMissing(sourcePath: string, targetPath: string): Promise<boolean> {
  if (fsSync.existsSync(targetPath)) return false;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

export async function seedPortConfigs(
  port: string | number,
  { silent = false, logger }: { silent?: boolean; logger?: SeedLogger } = {},
): Promise<string> {
  const targetDir = path.join(paths.dataServerBots, String(port));
  await fs.mkdir(targetDir, { recursive: true });

  const defaultFiles = await fs.readdir(paths.configDefault);
  const created = (
    await Promise.all(
      defaultFiles.map(async (file) => {
        if (!file.endsWith('.yaml') || file === 'qq.yaml') return null;
        const configName = path.basename(file, '.yaml');
        if (
          (GLOBAL_CONFIGS as readonly string[]).includes(configName) ||
          !isServerOrFactoryConfig(configName)
        ) {
          return null;
        }
        const copied = await copyFileIfMissing(
          path.join(paths.configDefault, file),
          path.join(targetDir, file),
        );
        return copied ? file : null;
      }),
    )
  ).filter(Boolean) as string[];

  if (!silent && logger) {
    if (created.length > 0) {
      await logger.success(`配置文件已就绪: ${targetDir} (新建: ${created.join(', ')})`);
    } else if (!fsSync.existsSync(path.join(targetDir, 'server.yaml'))) {
      await logger.success(`配置文件已就绪: ${targetDir}`);
    }
  }

  return targetDir;
}

export function seedGlobalConfigsSync(): void {
  const targetDir = paths.dataServerBots;
  fsSync.mkdirSync(targetDir, { recursive: true });

  for (const file of fsSync.readdirSync(paths.configDefault)) {
    if (!file.endsWith('.yaml')) continue;
    const configName = path.basename(file, '.yaml');
    if (!(GLOBAL_CONFIGS as readonly string[]).includes(configName)) continue;
    copyFileIfMissingSync(path.join(paths.configDefault, file), path.join(targetDir, file));
  }
}
