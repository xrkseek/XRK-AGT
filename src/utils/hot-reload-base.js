import chokidar from 'chokidar';
import lodash from 'lodash';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import { normalizeError } from '#utils/normalize-error.js';
import { isShuttingDown } from '#utils/runtime-globals.js';
import { isModuleSourceFile, moduleFileKey } from './module-ext.ts';

const DEFAULT_AWAIT_WRITE_FINISH = {
  stabilityThreshold: 300,
  pollInterval: 100
};

/** unlink 后若同路径 add/change 到来，取消误删（原子保存/重命名） */
const UNLINK_CONFIRM_MS = 600;

function normalizeWatchPath(filePath) {
  return path.resolve(String(filePath ?? ''));
}

function normalizeWatchTargets(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(normalizeWatchPath).filter(Boolean);
}

export class HotReloadBase {
  watcher = null;
  _debouncers = [];
  _stopping = false;
  _stopPromise = null;
  _pendingTargets = [];
  /** @type {Map<string, string>} 路径 → 内容 SHA256 */
  _fileHashes = new Map();
  /** @type {Set<string>} */
  _inFlight = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  _pendingUnlinks = new Map();

  constructor(options = {}) {
    this.loggerName = options.loggerName ?? 'HotReload';
    this.debounceDelay = options.debounceDelay ?? 500;
    this.awaitWriteFinish = options.awaitWriteFinish ?? DEFAULT_AWAIT_WRITE_FINISH;
  }

  get isWatching() {
    return Boolean(this.watcher) && !this._stopping;
  }

  isValidFile(filePath) {
    return isModuleSourceFile(filePath);
  }

  async _fileContentHash(filePath) {
    try {
      const content = await fs.readFile(filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  _cancelPendingUnlink(filePath) {
    const key = normalizeWatchPath(filePath);
    const timer = this._pendingUnlinks.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this._pendingUnlinks.delete(key);
  }

  /**
   * 内容未变则跳过重载（add/change 均适用）。
   * unlink 不在此处理，由延迟确认避免原子保存误触发。
   */
  async _markContentChanged(filePath) {
    const key = normalizeWatchPath(filePath);
    const hash = await this._fileContentHash(filePath);
    if (!hash) return false;

    const prev = this._fileHashes.get(key);
    if (prev === hash) {
      RuntimeUtil.makeLog(
        'debug',
        `跳过热更新（内容未变）: ${path.basename(filePath)}`,
        this.loggerName
      );
      return false;
    }

    this._fileHashes.set(key, hash);
    return true;
  }

  async _seedHashes(handleCheck) {
    if (!this.watcher?.getWatched) return;
    const watched = this.watcher.getWatched();
    for (const [dir, files] of Object.entries(watched)) {
      for (const file of files) {
        const full = path.join(dir, file);
        if (!handleCheck(full, 'seed')) continue;
        const hash = await this._fileContentHash(full);
        if (hash) this._fileHashes.set(normalizeWatchPath(full), hash);
      }
    }
  }

  async _runHandler(filePath, event, handler, { invalidateCoreCacheOnAdd = false } = {}) {
    if (!handler) return;
    const watchKey = normalizeWatchPath(filePath);
    if (this._inFlight.has(watchKey)) return;

    if (event === 'unlink' || event === 'unlinkDir') {
      this._scheduleUnlink(filePath, handler);
      return;
    }

    this._cancelPendingUnlink(filePath);
    if (!(await this._markContentChanged(filePath))) return;

    this._inFlight.add(watchKey);
    try {
      if (event === 'add' && invalidateCoreCacheOnAdd) {
        paths.invalidateCoreCache();
      }
      await handler(filePath);
    } catch (err) {
      const error = normalizeError(err);
      RuntimeUtil.makeLog('error', `热更新 ${event} 失败: ${filePath}`, this.loggerName, error);
    } finally {
      this._inFlight.delete(watchKey);
    }
  }

  _scheduleUnlink(filePath, handler) {
    const key = normalizeWatchPath(filePath);
    const existing = this._pendingUnlinks.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      this._pendingUnlinks.delete(key);
      if (this._stopping || !this.watcher) return;
      try {
        await fs.access(filePath);
        RuntimeUtil.makeLog(
          'debug',
          `跳过 unlink（文件已恢复，多为原子保存）: ${path.basename(filePath)}`,
          this.loggerName
        );
        return;
      } catch {
        this._fileHashes.delete(key);
      }
      if (this._inFlight.has(key)) return;
      this._inFlight.add(key);
      try {
        await handler(filePath);
      } catch (err) {
        const error = normalizeError(err);
        RuntimeUtil.makeLog('error', `热更新 unlink 失败: ${filePath}`, this.loggerName, error);
      } finally {
        this._inFlight.delete(key);
      }
    }, UNLINK_CONFIRM_MS);

    this._pendingUnlinks.set(key, timer);
  }

  /**
   * @param {boolean} enable
   * @param {object} options
   * @param {string|string[]} [options.dirs]
   * @param {string|string[]} [options.files]
   * @param {(filePath: string) => void|Promise<void>} [options.onAdd]
   * @param {(filePath: string) => void|Promise<void>} [options.onChange]
   * @param {(filePath: string) => void|Promise<void>} [options.onUnlink]
   * @param {(dirPath: string) => void|Promise<void>} [options.onAddDir]
   * @param {(dirPath: string) => void|Promise<void>} [options.onUnlinkDir]
   * @param {(filePath: string, event: string) => boolean} [options.shouldHandle]
   * @param {boolean} [options.invalidateCoreCacheOnAdd]
   */
  async watch(enable = true, options = {}) {
    if (!enable) {
      await this.stop();
      return false;
    }
    if (isShuttingDown() || this._stopping) return false;
    if (this.watcher) return true;

    const {
      dirs,
      files,
      onAdd,
      onChange,
      onUnlink,
      onAddDir,
      onUnlinkDir,
      shouldHandle,
      invalidateCoreCacheOnAdd = normalizeWatchTargets(files).length === 0
    } = options;

    const targets = [
      ...normalizeWatchTargets(dirs),
      ...normalizeWatchTargets(files),
      ...this._pendingTargets.splice(0)
    ];
    if (targets.length === 0) return false;

    if (this._stopping || isShuttingDown()) return false;

    const handleCheck = shouldHandle ?? ((filePath) => this.isValidFile(filePath));

    try {
      this.watcher = chokidar.watch(targets, {
        ignored: /(^|[/\\])\../,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: this.awaitWriteFinish
      });
    } catch (err) {
      this.watcher = null;
      const error = normalizeError(err);
      RuntimeUtil.makeLog('error', `启动文件监视失败: ${error.message}`, this.loggerName, error);
      return false;
    }

    const bind = (event, handler, { skipCheck = false, invalidateOnAdd = false } = {}) => {
      if (!handler) return;
      const debounced = lodash.debounce((filePath) => {
        if (this._stopping || !this.watcher) return;
        if (!skipCheck && !handleCheck(filePath, event)) return;
        void this._runHandler(filePath, event, handler, {
          invalidateCoreCacheOnAdd: invalidateOnAdd && event === 'add'
        });
      }, this.debounceDelay);
      this._debouncers.push(debounced);
      this.watcher.on(event, debounced);
    };

    bind('add', onAdd, { invalidateOnAdd: invalidateCoreCacheOnAdd });
    bind('change', onChange);
    bind('unlink', onUnlink);
    bind('addDir', onAddDir, { skipCheck: true });
    bind('unlinkDir', onUnlinkDir, { skipCheck: true });

    this.watcher.on('ready', () => {
      void this._seedHashes(handleCheck);
    });

    this.watcher.on('error', (err) => {
      if (this._stopping) return;
      const error = normalizeError(err);
      RuntimeUtil.makeLog('error', '文件监视错误', this.loggerName, error);
    });
    RuntimeUtil.makeLog('info', '文件监视已启动', this.loggerName);
    return true;
  }

  addTargets(targets) {
    if (this._stopping || isShuttingDown()) return false;

    const list = normalizeWatchTargets(targets);
    if (list.length === 0) return true;

    if (!this.watcher) {
      this._pendingTargets.push(...list);
      return true;
    }

    try {
      for (const target of list) {
        this.watcher.add(target);
      }
      return true;
    } catch (err) {
      const error = normalizeError(err);
      RuntimeUtil.makeLog('error', `追加监视路径失败: ${error.message}`, this.loggerName, error);
      return false;
    }
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopInternal();
    try {
      await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }

  async _stopInternal() {
    this._stopping = true;
    this._pendingTargets.length = 0;

    for (const timer of this._pendingUnlinks.values()) {
      clearTimeout(timer);
    }
    this._pendingUnlinks.clear();
    this._fileHashes.clear();
    this._inFlight.clear();

    for (const debounced of this._debouncers) {
      debounced.cancel?.();
    }
    this._debouncers.length = 0;

    const watcher = this.watcher;
    this.watcher = null;
    if (!watcher) {
      this._stopping = false;
      return;
    }

    watcher.removeAllListeners();
    try {
      await watcher.close();
    } catch (err) {
      const error = normalizeError(err);
      RuntimeUtil.makeLog('debug', `关闭文件监视: ${error.message}`, this.loggerName);
    } finally {
      this._stopping = false;
    }
  }

  getFileKey(filePath) {
    return moduleFileKey(filePath);
  }

  static moduleFileKey(nameOrPath) {
    return moduleFileKey(nameOrPath);
  }

  static resolveWatchPath(filePath) {
    return normalizeWatchPath(filePath);
  }
}
