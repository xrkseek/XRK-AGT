/**
 * 目录递归遍历的单一实现。
 *
 * 此前 src/ 下有四份同构的 walk（agent-workspace / agent-managed-skills /
 * trigger-microagents ×2），差异藏在四个维度：跳隐藏、跳 node_modules、
 * 深度上限、条数上限。逐份维护的后果是 agent-managed-skills 那份漏了
 * `node_modules` 跳过——它用于算 skills 目录指纹，于是装过依赖的 skill 会
 * 递归进几十万文件（拖慢）且指纹随 node_modules 漂移。
 *
 * 现在四份统一走本函数，差异通过显式选项表达。
 */
import fs from 'node:fs';
import path from 'node:path';

export type WalkFilesOptions = {
  /** 目录名黑名单（默认 node_modules） */
  skipDirs?: ReadonlySet<string>;
  /** 深度上限，根目录为 0；不传表示不限 */
  maxDepth?: number;
  /** 收集结果条数上限（含目录项占用的预算）；不传表示不限 */
  maxFiles?: number;
  /** 文件名匹配（不传表示收集所有普通文件） */
  match?: (name: string, filePath: string) => boolean;
};

const DEFAULT_SKIP_DIRS = new Set(['node_modules']);

/**
 * 递归收集匹配文件；目录读取失败（权限/竞态删除）静默跳过，不中断整棵树。
 *
 * @returns 命中文件的绝对路径（顺序为遍历序，调用方需自行排序）
 */
export function walkFiles(root: string, opts: WalkFilesOptions = {}): string[] {
  const { skipDirs = DEFAULT_SKIP_DIRS, maxDepth, maxFiles, match } = opts;
  const out: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (maxFiles !== undefined && out.length >= maxFiles) return;
    if (maxDepth !== undefined && depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (maxFiles !== undefined && out.length >= maxFiles) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (e.isFile() && (!match || match(e.name, abs))) out.push(abs);
    }
  };

  walk(root, 0);
  return out;
}