import fs from 'fs/promises';
import path from 'path';
import { exec } from '#utils/exec-async.js';
import { getDefaultDesktopDirSync } from '#utils/user-dirs.js';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';

const IS_WINDOWS = process.platform === 'win32';

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

type WritableGate = { ok: true } | { ok: false; error: string };

type SearchFilesOptions = {
  maxDepth?: number;
  fileExtensions?: string[] | null;
  caseSensitive?: boolean;
};

type GrepOptions = {
  caseSensitive?: boolean;
  maxResults?: number;
};

type ListDirOptions = {
  includeHidden?: boolean;
  type?: 'all' | 'files' | 'dirs' | string;
};

type ExecuteCommandOptions = {
  cwd?: string;
  timeout?: number;
};

/**
 * 统一基础工具系统
 * 提供文件操作、文本处理等核心功能，类似Cursor的工具集
 */
export class BaseTools {
  processRegistry: Set<number> = new Set();
  workspace: string;

  constructor(workspace: string | null = null) {
    this.workspace = workspace || getDefaultDesktopDirSync();
  }

  /**
   * 读取文件
   */
  async readFile(filePath: string, encoding: BufferEncoding = 'utf8') {
    const fullPath = this.resolvePath(filePath);
    try {
      const content = await fs.readFile(fullPath, encoding);
      return { success: true as const, content, path: fullPath };
    } catch (error: any) {
      return { success: false as const, error: error.message, path: fullPath };
    }
  }

  /**
   * 按 oldText 精确替换为 newText（须唯一，除非 replaceAll）。
   * 语义对齐 Yunzai BaseTools.searchReplace。
   */
  async searchReplace(
    filePath: string,
    oldText: string | null | undefined,
    newText: string | null | undefined,
    options: { replaceAll?: boolean } = {},
  ) {
    const { replaceAll = false } = options;
    if (oldText == null || oldText === '') {
      return { success: false as const, error: 'oldText 不能为空' };
    }
    if (newText == null) {
      return { success: false as const, error: 'newText 不能省略（可传空字符串）' };
    }
    const fullPath = this.resolvePath(filePath);
    const gate = this.assertWritablePath(fullPath);
    if (!gate.ok) return { success: false as const, error: gate.error, path: fullPath };
    try {
      const existing = await fs.readFile(fullPath, 'utf8');
      const count = countOccurrences(existing, oldText);
      if (count === 0) {
        return { success: false as const, error: '未找到 oldText，请 read 核对片段或扩大上下文', path: fullPath };
      }
      if (!replaceAll && count > 1) {
        return {
          success: false as const,
          error: `oldText 出现 ${count} 次，请加长上下文使其唯一，或设 replaceAll=true`,
          path: fullPath,
          occurrences: count
        };
      }
      const newContent = replaceAll
        ? existing.split(oldText).join(newText)
        : existing.replace(oldText, newText);
      await fs.writeFile(fullPath, newContent, 'utf8');
      return {
        success: true as const,
        path: fullPath,
        replacements: replaceAll ? count : 1,
        replaceAll: !!replaceAll
      };
    } catch (error: any) {
      return { success: false as const, error: error.message, path: fullPath };
    }
  }

  /**
   * 写入文件。overwrite=false 时若目标已存在则拒绝（逼模型改用 searchReplace）。
   */
  async writeFile(
    filePath: string,
    content: string,
    encoding: BufferEncoding = 'utf8',
    options: { overwrite?: boolean } = {},
  ) {
    const { overwrite = false } = options;
    const fullPath = this.resolvePath(filePath);
    const gate = this.assertWritablePath(fullPath);
    if (!gate.ok) return { success: false as const, error: gate.error, path: fullPath };
    try {
      let exists = false;
      try {
        await fs.access(fullPath);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && !overwrite) {
        return {
          success: false as const,
          error: '文件已存在：局部改动请用 search_replace；确需整文件覆盖请传 overwrite=true',
          path: fullPath
        };
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, encoding);
      return { success: true as const, path: fullPath, overwritten: exists };
    } catch (error: any) {
      return { success: false as const, error: error.message, path: fullPath };
    }
  }

  /**
   * 搜索文件（在工作区递归搜索）
   */
  async searchFiles(pattern: string, options: SearchFilesOptions = {}): Promise<string[]> {
    const {
      maxDepth = 3,
      fileExtensions = null,
      caseSensitive = false
    } = options;

    const results: string[] = [];
    const searchPattern = caseSensitive
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const searchDir = async (dir: string, depth = 0): Promise<void> => {
      if (depth > maxDepth) return;

      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            await searchDir(fullPath, depth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (fileExtensions && !fileExtensions.includes(ext)) continue;
            if (searchPattern.test(entry.name) || searchPattern.test(fullPath)) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // 忽略权限错误等
      }
    };

    await searchDir(this.workspace);
    return results;
  }

  /**
   * Grep搜索（在文件中搜索文本）
   */
  async grep(pattern: string, filePath: string | null = null, options: GrepOptions = {}) {
    const {
      caseSensitive = false,
      maxResults = 100
    } = options;

    const searchPattern = caseSensitive
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const searchInFile = async (file: string) => {
      try {
        const content = await fs.readFile(file, 'utf8');
        const lines = content.split('\n');
        const matches: Array<{ file: string; line: number; content: string }> = [];

        for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
          if (searchPattern.test(lines[i])) {
            matches.push({
              file,
              line: i + 1,
              content: lines[i].trim()
            });
          }
        }

        return matches;
      } catch {
        return [];
      }
    };

    if (filePath) {
      const fullPath = this.resolvePath(filePath);
      const matches = await searchInFile(fullPath);
      return { success: true as const, matches };
    } else {
      // 在工作区搜索所有文本文件
      const textFiles = await this.searchFiles('', {
        fileExtensions: ['.txt', '.md', '.js', '.json', '.py', '.java', '.cpp', '.c', '.h']
      });

      const allMatches: Array<{ file: string; line: number; content: string }> = [];
      for (const file of textFiles) {
        const matches = await searchInFile(file);
        allMatches.push(...matches);
        if (allMatches.length >= maxResults) break;
      }

      return { success: true as const, matches: allMatches.slice(0, maxResults) };
    }
  }

  /**
   * 列出目录内容
   */
  async listDir(dirPath: string | null = null, options: ListDirOptions = {}) {
    const { includeHidden = false, type = 'all' } = options;
    const targetDir = dirPath ? this.resolvePath(dirPath) : this.workspace;

    try {
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const items: Array<{
        name: string;
        path: string;
        type: 'directory' | 'file';
        size: number | null;
        modified: Date;
      }> = [];

      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;

        const fullPath = path.join(targetDir, entry.name);
        const stats = await fs.stat(fullPath);

        if (type === 'files' && !stats.isFile()) continue;
        if (type === 'dirs' && !stats.isDirectory()) continue;

        items.push({
          name: entry.name,
          path: fullPath,
          type: stats.isDirectory() ? 'directory' : 'file',
          size: stats.isFile() ? stats.size : null,
          modified: stats.mtime
        });
      }

      return { success: true as const, items, path: targetDir };
    } catch (error: any) {
      return { success: false as const, error: error.message, path: targetDir };
    }
  }

  /**
   * 解析路径（相对路径转为绝对路径）
   */
  resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.join(this.workspace, filePath);
  }

  /**
   * 写入类操作必须落在工作区内（可读项目根 .cursor/docs；不可改框架）
   */
  assertWritablePath(fullPath: string): WritableGate {
    const root = realpathSyncOrResolve(this.workspace);
    const target = realpathSyncOrResolve(fullPath);
    if (!isPathInside(root, target)) {
      return {
        ok: false,
        error:
          '只能写入当前工作区（业务代码：core/workspace-Core/）。了解框架请 read ../../../.cursor/skills/ 或 ../../../docs/，禁止改 .cursor / src / 仓库 core',
      };
    }
    return { ok: true };
  }

  /**
   * 执行命令（注册进程以便后续清理）
   */
  async executeCommand(command: string, options: ExecuteCommandOptions = {}) {
    const {
      cwd = this.workspace,
      timeout = 30000
    } = options;

    try {
      const result = await exec(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024
      });

      return {
        success: true as const,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      };
    } catch (error: any) {
      return {
        success: false as const,
        error: error.message,
        stderr: error.stderr || '',
        stdout: error.stdout || ''
      };
    }
  }

  /**
   * 获取已注册的进程列表
   */
  getRegisteredProcesses(): number[] {
    return Array.from(this.processRegistry);
  }

  /**
   * 清理已注册的进程
   */
  async cleanupProcesses() {
    const killed: number[] = [];
    for (const pid of this.processRegistry) {
      try {
        if (IS_WINDOWS) {
          await exec(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        } else {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            /* ESRCH 等 */
          }
        }
        killed.push(pid);
        this.processRegistry.delete(pid);
      } catch {
        this.processRegistry.delete(pid);
      }
    }

    return { success: true as const, killed };
  }

  /**
   * 监控并清理无用进程（自动检测）
   */
  async autoCleanupProcesses(excludePatterns: RegExp[] = []) {
    if (!IS_WINDOWS) {
      return { success: true as const, killed: [] as number[], note: '非 Windows：不扫描系统进程列表；请用 cleanupProcesses 清理已登记 PID' };
    }

    try {
      const { stdout } = await exec('tasklist /FO CSV /NH', { encoding: 'utf8' });
      const lines = (stdout as string).split('\n').filter((line) => line.trim());

      const processes = lines.map((line) => {
        const parts = line.match(/"([^"]+)"/g);
        if (!parts || parts.length < 2) return null;
        return {
          name: parts[0].replace(/"/g, ''),
          pid: parseInt(parts[1].replace(/"/g, ''))
        };
      }).filter((proc): proc is { name: string; pid: number } => Boolean(proc));

      // 检测无用进程（可根据需要扩展逻辑）
      const killed: number[] = [];
      for (const proc of processes) {
        // 排除系统进程和重要应用
        if (excludePatterns.some((p) => p.test(proc.name))) continue;
        if (proc.name.includes('System') || proc.name.includes('explorer')) continue;

        // 可以添加更多判断逻辑，比如检测长时间无活动的进程
        // 这里简化处理，只清理明确注册的进程
      }

      return { success: true as const, killed };
    } catch (error: any) {
      return { success: false as const, error: error.message };
    }
  }
}
