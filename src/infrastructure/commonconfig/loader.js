import path from 'node:path';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import { findInCoreSubDirs, resolveQualifiedCoreModuleKey } from '#utils/core-fs.js';
import { FileLoader } from '#utils/file-loader.js';
import { HotReloadBase } from '#utils/hot-reload-base.js';
import { LOADER_BATCH_SIZE } from '#utils/loader-constants.js';

class CommonConfigRegistry {
  configs = new Map();
  loaded = false;
  _hotReload = null;
  _configDirsCache = null;

  async load() {
    const startTime = Date.now();
    RuntimeUtil.makeLog('info', '开始加载配置管理器...', 'CommonConfigRegistry');

    const allFiles = await FileLoader.getCoreSubDirFiles('commonconfig', {
      recursive: false
    });

    this._configDirsCache = await paths.getCoreSubDirs('commonconfig');
    await FileLoader.forEachBatch(allFiles, LOADER_BATCH_SIZE, (file) => this._loadConfig(file));
    this._configDirsCache = null;

    this.loaded = true;
    RuntimeUtil.makeLog(
      'info',
      `配置管理器加载完成: ${this.configs.size}个, 耗时${Date.now() - startTime}ms`,
      'CommonConfigRegistry'
    );
    return this.configs;
  }

  _configKey(filePath) {
    const dirs = this._configDirsCache ?? [];
    return resolveQualifiedCoreModuleKey(filePath, dirs, 'commonconfig');
  }

  async _loadConfig(filePath) {
    try {
      const dirs = this._configDirsCache ?? await paths.getCoreSubDirs('commonconfig');
      const key = resolveQualifiedCoreModuleKey(filePath, dirs, 'commonconfig');
      const module = await FileLoader.importFresh(filePath);
      if (!module.default) {
        RuntimeUtil.makeLog('warn', `无效的配置模块: ${key}`, 'CommonConfigRegistry');
        return false;
      }

      const configInstance = typeof module.default === 'function'
        ? new module.default()
        : module.default;

      configInstance.key = key;
      // 勿覆盖 ConfigBase 构造里的 filePath（数据文件路径）；模块路径单独挂
      configInstance.modulePath = filePath;
      this.configs.set(key, configInstance);
      // 短名用 get() 回退解析（system-Core/x → x），勿再 Map 双挂同一实例
      RuntimeUtil.makeLog('debug', `加载配置: ${configInstance.displayName ?? key}`, 'CommonConfigRegistry');
      return true;
    } catch (error) {
      RuntimeUtil.makeLog('error', `加载配置失败: ${filePath} - ${error.message}`, 'CommonConfigRegistry', error);
      return false;
    }
  }

  /**
   * @param {string} name 短名（ai_config）或限定名（system-Core/ai_config）
   */
  get(name) {
    if (!name) return null;
    if (this.configs.has(name)) return this.configs.get(name);
    if (!String(name).includes('/')) {
      const sys = this.configs.get(`system-Core/${name}`);
      if (sys) return sys;
      for (const [key, inst] of this.configs) {
        if (String(key).endsWith(`/${name}`)) return inst;
      }
    }
    return null;
  }

  getAll() {
    return this.configs;
  }

  getList() {
    const seen = new Set();
    return [...this.configs.entries()]
      .filter(([key, config]) => {
        if (!key.includes('/')) return false;
        if (seen.has(config)) return false;
        seen.add(config);
        return typeof config.getStructure === 'function';
      })
      .map(([, config]) => config.getStructure());
  }

  async reload(name) {
    const configPath = findInCoreSubDirs(await paths.getCoreSubDirs('commonconfig'), name.includes('/') ? path.basename(name) : name);
    if (!configPath) {
      RuntimeUtil.makeLog('error', `配置重载失败: ${name} 文件不存在`, 'CommonConfigRegistry');
      return false;
    }
    return this.reloadFile(configPath);
  }

  /** 按监视器报告的绝对路径重载（避免 basename 歧义） */
  async reloadFile(configPath) {
    const ok = await this._loadConfig(configPath);
    if (ok) {
      const key = resolveQualifiedCoreModuleKey(
        configPath,
        await paths.getCoreSubDirs('commonconfig'),
        'commonconfig'
      );
      this.configs.get(key)?.clearCache?.();
      RuntimeUtil.makeLog('info', `配置已重载: ${key}`, 'CommonConfigRegistry');
    }
    return ok;
  }

  clearAllCache() {
    const seen = new Set();
    for (const config of this.configs.values()) {
      if (seen.has(config)) continue;
      seen.add(config);
      config.clearCache?.();
    }
  }

  async watch(enable = true) {
    if (!enable) {
      await this._hotReload?.stop();
      this._hotReload = null;
      return;
    }
    if (this._hotReload?.watcher) return;

    try {
      const hotReload = new HotReloadBase({ loggerName: 'CommonConfigRegistry' });
      const configDirs = await paths.getCoreSubDirs('commonconfig');
      if (configDirs.length === 0) return;

      const started = await hotReload.watch(true, {
        dirs: configDirs,
        onAdd: (filePath) => this._loadConfig(filePath),
        onChange: (filePath) => this.reloadFile(filePath),
        onUnlink: (filePath) => {
          const key = resolveQualifiedCoreModuleKey(filePath, configDirs, 'commonconfig');
          this.configs.delete(key);
        }
      });
      if (started) this._hotReload = hotReload;
    } catch (error) {
      RuntimeUtil.makeLog('error', '启动 CommonConfig 文件监视失败', 'CommonConfigRegistry', error);
    }
  }
}

export default new CommonConfigRegistry();
