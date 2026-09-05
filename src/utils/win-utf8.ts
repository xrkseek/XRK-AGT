import { spawnSync } from 'node:child_process';

/** 修复 Windows 控制台 UTF-8 显示（引导菜单与 pino 日志初始化前均需调用） */
export function fixWindowsUTF8(): void {
  if (process.platform !== 'win32') return;
  try {
    process.stdout.setEncoding('utf8');
    process.stderr.setEncoding('utf8');
    spawnSync('chcp', ['65001'], { stdio: 'ignore', shell: false });
  } catch {
    /* ignore */
  }
}
