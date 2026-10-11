/**
 * 用户目录解析（跨平台），供 BaseTools、DesktopStream 等复用，避免各处硬编码「Desktop」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 同步解析默认桌面目录（构造期/无 await 场景）。
 * Windows 尝试 %USERPROFILE%\Desktop 与 \桌面；Unix 尊重 XDG_USER_DESKTOP_DIR，其次 Desktop / 桌面。
 */
export function getDefaultDesktopDirSync(): string {
  const home = os.homedir();

  if (process.env.XDG_USER_DESKTOP_DIR) {
    const xdg = path.normalize(process.env.XDG_USER_DESKTOP_DIR);
    try {
      if (fs.existsSync(xdg)) return xdg;
    } catch {
      /* ignore */
    }
  }

  for (const name of ['Desktop', '桌面']) {
    const p = path.join(home, name);
    try {
      if (fs.existsSync(p)) return path.normalize(p);
    } catch {
      /* ignore */
    }
  }

  return path.normalize(path.join(home, 'Desktop'));
}
