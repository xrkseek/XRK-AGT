// @ts-nocheck
import PluginLoader from '#infrastructure/plugins/loader.js';
import { HttpResponse } from '#utils/http-utils.js';
import RuntimeUtil from '#utils/runtime-util.js';


function collectPluginEntries() {
  const priorityPlugins = PluginLoader.priority || [];
  const extendedPlugins = PluginLoader.extended || [];
  const allPlugins = [...priorityPlugins, ...extendedPlugins];
  const plugins = [];

  for (const entry of allPlugins) {
    if (!entry?.class) continue;
    try {
      const instance = new entry.class();
      plugins.push({
        key: entry.key,
        name: instance.name || entry.key,
        priority: entry.priority,
        dsc: instance.dsc || '暂无描述',
        rule: instance.rule?.length || 0,
        task: instance.task ? 1 : 0
      });
    } catch (error) {
      RuntimeUtil.makeLog('error', `[Plugin API] 初始化插件失败: ${entry.key}`, 'Plugin', error);
    }
  }

  return plugins;
}

function buildPluginStats(plugins = []) {
  const stats = PluginLoader.pluginLoadStats || {};
  const taskList = PluginLoader.task || [];
  return {
    totalPlugins: plugins.length,
    totalLoadTime: stats.totalLoadTime || 0,
    startTime: stats.startTime || 0,
    taskCount: taskList.length,
    extendedCount: (PluginLoader.extended || []).length,
    withRules: plugins.filter(p => (p.rule || 0) > 0).length,
    withTasks: plugins.filter(p => p.task > 0).length,
    plugins: stats.plugins || []
  };
}

function getPluginsWithSummary() {
  const plugins = collectPluginEntries();
  return { plugins, summary: buildPluginStats(plugins) };
}

/**
 * 插件管理API
 * 提供插件列表查询、重载、任务管理等功能
 */
export default {
  name: 'plugin',
  dsc: '插件管理API',
  priority: 80,

  routes: [
    {
      method: 'GET',
      path: '/api/plugins',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const plugins = collectPluginEntries();
        HttpResponse.success(res, { plugins });
      }, 'plugin.list')
    },

    {
      method: 'GET',
      path: '/api/plugins/summary',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { plugins, summary } = getPluginsWithSummary();
        HttpResponse.success(res, { summary, plugins });
      }, 'plugin.summary')
    },

    {
      method: 'POST',
      path: '/api/plugin/:key/reload',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { key } = req.params;
        if (!key) {
          return HttpResponse.validationError(res, '缺少插件key参数');
        }

        await PluginLoader.changePlugin(decodeURIComponent(key));
        HttpResponse.success(res, null, '插件重载成功');
      }, 'plugin.reload')
    },

    {
      method: 'GET',
      path: '/api/plugins/tasks',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const taskList = PluginLoader.task || [];
        const tasks = taskList.map(t => ({
          name: t.name,
          cron: t.cron,
          nextRun: t.job?.nextInvocation ? t.job.nextInvocation() : null
        }));

        HttpResponse.success(res, { tasks });
      }, 'plugin.tasks')
    },

    {
      method: 'GET',
      path: '/api/plugins/stats',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { summary } = getPluginsWithSummary();
        HttpResponse.success(res, { stats: summary });
      }, 'plugin.stats')
    }
  ]
};