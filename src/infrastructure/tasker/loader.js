import path from 'node:path';
import RuntimeUtil from '#utils/runtime-util.js';
import { FileLoader } from '#utils/file-loader.js';
import { setRuntimeGlobal } from '#utils/runtime-globals.js';

class TaskerLoader {
  loggerNs = 'TaskerLoader';

  async load(bot = AgentRuntime) {
    setRuntimeGlobal('AgentRuntime', bot);

    const summary = { scanned: 0, loaded: 0, failed: 0, registered: 0, errors: [] };
    const files = await this.getTaskerFiles();
    summary.scanned = files.length;

    if (files.length === 0) {
      RuntimeUtil.makeLog('info', '未找到 tasker 文件', this.loggerNs);
      return summary;
    }

    const countBefore = bot.tasker.length;

    await Promise.allSettled(
      files.map(async ({ name, filePath }) => {
        try {
          const mod = await FileLoader.importFresh(filePath);
          if (typeof mod.register === 'function') await mod.register(bot);
          summary.loaded += 1;
        } catch (err) {
          summary.failed += 1;
          summary.errors.push({ name, message: err.message });
          RuntimeUtil.makeLog('error', `导入 tasker 失败: ${name} - ${err.message}`, this.loggerNs, err);
        }
      })
    );

    this.dedupeTaskers(bot);

    summary.registered = bot.tasker.length - countBefore;
    RuntimeUtil.makeLog(
      summary.failed ? 'warn' : 'info',
      `Tasker 加载完成: 成功${summary.loaded}个, 注册${summary.registered}个${summary.failed ? `, 失败${summary.failed}个` : ''}`,
      this.loggerNs
    );
    return summary;
  }

  /** 按 path（无则 id）去重；OPQ/OneBot 同 id=QQ 但 path 不同，均保留 */
  dedupeTaskers(bot) {
    const seen = new Set();
    const next = [];
    for (const t of bot.tasker) {
      const key = String(t?.path || t?.id || '');
      if (!key) {
        next.push(t);
        continue;
      }
      if (seen.has(key)) {
        RuntimeUtil.makeLog('warn', `跳过重复 tasker: ${t?.name || '?'}(${key})`, this.loggerNs);
        continue;
      }
      seen.add(key);
      next.push(t);
    }
    if (next.length === bot.tasker.length) return;
    bot.tasker.length = 0;
    bot.tasker.push(...next);
  }

  async getTaskerFiles() {
    const filePaths = await FileLoader.getCoreSubDirFiles('tasker', {
      recursive: false
    });
    return filePaths.map((filePath) => ({
      name: path.basename(filePath),
      filePath,
      core: path.basename(path.dirname(path.dirname(filePath)))
    }));
  }
}

export default new TaskerLoader();
