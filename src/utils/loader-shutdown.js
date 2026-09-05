/**
 * 停机时销毁 Loader / 配置资源（无文件监视器）。
 */
import PluginLoader from '#infrastructure/plugins/loader.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import runtimeConfig from '#infrastructure/config/config.js';
import RendererLoader from '#infrastructure/renderer/loader.js';
import { setShuttingDown } from '#utils/runtime-globals.js';

export async function stopAllLoaderWatchers() {
  setShuttingDown(true);
  await PluginLoader.destroy().catch(() => {});
  await AiWorkflowLoader.cleanupAll().catch(() => {});
  await RendererLoader.stopAllWatchers?.().catch(() => {});
  await runtimeConfig.destroy().catch(() => {});
}
