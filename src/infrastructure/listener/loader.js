import path from 'node:path';
import TaskerLoader from '#infrastructure/tasker/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { FileLoader } from '#utils/file-loader.js';
import { LOADER_BATCH_SIZE } from '#utils/loader-constants.js';

class ListenerLoader {
  bot = null;

  async load(bot) {
    this.bot = bot;
    let eventCount = 0;

    const eventFiles = await FileLoader.getCoreSubDirFiles('events', {
      ext: '.js',
      recursive: false
    });

    if (eventFiles.length > 0) {
      RuntimeUtil.makeLog('info', '加载监听事件中...', 'ListenerLoader');

      const loadEventFile = async (filePath) => {
        const file = path.basename(filePath);
        RuntimeUtil.makeLog('debug', `加载监听事件: ${file}`, 'ListenerLoader');
        const listener = await FileLoader.importFresh(filePath);
        if (!listener.default) return 0;

        const instance = new listener.default();
        instance.bot = this.bot;

        if (typeof instance.init !== 'function') {
          RuntimeUtil.makeLog('warn', `监听事件 ${file} 缺少 init()，已跳过`, 'ListenerLoader');
          return 0;
        }
        await instance.init();
        return 1;
      };

      const results = await FileLoader.mapInBatches(eventFiles, LOADER_BATCH_SIZE, loadEventFile);
      for (const result of results) {
        if (result.status === 'fulfilled') eventCount += result.value;
        else RuntimeUtil.makeLog('error', `监听事件加载错误: ${result.reason.message}`, 'ListenerLoader', result.reason);
      }
    }

    RuntimeUtil.makeLog('info', `加载监听事件[${eventCount}个]`, 'ListenerLoader');
    RuntimeUtil.makeLog(
      'debug',
      'events / tasker 不支持热重载，修改后需重启进程',
      'ListenerLoader'
    );

    if (process.argv.includes('server')) {
      await this.loadTaskers();
    }
  }

  async loadTaskers() {
    RuntimeUtil.makeLog('info', '加载 tasker 中...', 'ListenerLoader');
    await TaskerLoader.load(this.bot);

    if (this.bot.tasker.length === 0) {
      RuntimeUtil.makeLog('warn', '未找到已注册的 tasker', 'ListenerLoader');
      return;
    }

    RuntimeUtil.makeLog('info', '初始化 tasker 中...', 'ListenerLoader');
    let taskerCount = 0;
    let taskerErrorCount = 0;

    const initResults = await Promise.allSettled(
      this.bot.tasker.map(async (tasker) => {
        if (typeof tasker.load !== 'function') {
          RuntimeUtil.makeLog('warn', `tasker 无效: ${tasker.name}(${tasker.id})`, 'ListenerLoader');
          return false;
        }
        RuntimeUtil.makeLog('debug', `初始化 tasker: ${tasker.name}(${tasker.id})`, 'ListenerLoader');
        await tasker.load();
        return true;
      })
    );

    for (const result of initResults) {
      if (result.status === 'fulfilled' && result.value) taskerCount++;
      else if (result.status === 'rejected') {
        taskerErrorCount++;
        RuntimeUtil.makeLog('error', `tasker 初始化错误: ${result.reason.message}`, 'ListenerLoader', result.reason);
      }
    }

    RuntimeUtil.makeLog(
      'info',
      `初始化 tasker[${taskerCount}个]${taskerErrorCount > 0 ? `, 失败${taskerErrorCount}个` : ''}`,
      'ListenerLoader'
    );
  }
}

export default new ListenerLoader();
