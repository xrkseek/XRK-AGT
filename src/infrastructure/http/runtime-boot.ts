/**
 * 启动汇总输出与 trash 清理（从 AgentRuntime 拆出）
 */
import path from 'path';
import fs from 'node:fs/promises';
import os from 'node:os';
import chalk from 'chalk';
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import paths from '#utils/paths.js';
import HttpApiLoader from '#infrastructure/http/loader.js';
import PluginLoader from '#infrastructure/plugins/loader.js';
import ListenerLoader from '#infrastructure/listener/loader.js';
import bootstrapRuntimePackages from '#infrastructure/config/loader.js';
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { setRuntimeGlobal } from '#utils/runtime-globals.js';
import { maskSensitive } from '#infrastructure/http/runtime-auth.js';
import { displayAccessUrls, getProxyConfig, isHttpsEnabled } from '#infrastructure/http/runtime-net.js';

/**
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {number} loadTime
 * @param {number} startTime
 * @param {Record<string, number>} [timings]
 */
export async function displayStartupSummary(runtime: any, loadTime: any, startTime: any, timings: any = {}) {
  const memUsage = process.memoryUsage();
  const memMB = (size: any) => `${(size / 1024 / 1024).toFixed(2)}MB`;

  console.log(chalk.cyan(`\n${'═'.repeat(60)}`));
  console.log(`${chalk.cyan('║')}${chalk.bold('  XRK-AGT 启动完成')}${' '.repeat(40)}${chalk.cyan('║')}`);
  console.log(chalk.cyan('═'.repeat(60)));

  console.log(chalk.yellow('\n▶ 启动统计：'));
  console.log(`    ${chalk.cyan('•')} 总耗时：${chalk.white(`${loadTime}ms`)}`);
  console.log(`    ${chalk.cyan('•')} 启动时间：${chalk.white(new Date(startTime).toLocaleString('zh-CN'))}`);
  console.log(`    ${chalk.cyan('•')} 运行时长：${chalk.white(`${process.uptime().toFixed(2)}s`)}`);

  const phaseLabels: Record<string, string> = {
    proxyInit: '反向代理初始化',
    bootstrapPackages: 'bootstrapRuntimePackages',
    commonConfig: 'CommonConfig',
    loaders: 'Workflow/Plugins/Api 并行加载',
    middleware: '中间件与路由',
    apiRegister: 'API 注册',
    apiKey: 'API 密钥',
    httpListen: 'HTTP/HTTPS 监听',
    proxyListen: '代理监听',
    listener: '事件/Tasker',
  };
  const phaseEntries = Object.entries(timings)
    .filter(([, ms]: any) => Number.isFinite(ms))
    .sort((a: any, b: any) => b[1] - a[1]);
  if (phaseEntries.length > 0) {
    console.log(chalk.yellow('\n▶ 分阶段耗时：'));
    for (const [key, ms] of phaseEntries) {
      const label = phaseLabels[key] || key;
      console.log(`    ${chalk.cyan('•')} ${label}：${chalk.white(`${ms}ms`)}`);
    }
  }

  console.log(chalk.yellow('\n▶ 服务器信息：'));
  console.log(`    ${chalk.cyan('•')} HTTP端口：${chalk.white(runtime.actualPort)}`);
  if (runtime.actualHttpsPort) {
    console.log(`    ${chalk.cyan('•')} HTTPS端口：${chalk.white(runtime.actualHttpsPort)}`);
  }
  console.log(`    ${chalk.cyan('•')} 服务器地址：${chalk.white(runtime.getServerUrl())}`);
  if (runtime.proxyEnabled) {
    console.log(`    ${chalk.cyan('•')} 反向代理：${chalk.green('已启用')} (${runtime.domainConfigs.size}个域名)`);
  }

  const wsPaths = Object.keys(runtime.wsf);
  if (wsPaths.length > 0) {
    console.log(chalk.yellow('\n▶ WebSocket服务：'));
    console.log(`    ${chalk.cyan('•')} 服务地址：${chalk.white(runtime.getServerUrl().replace(/^http/, 'ws'))}`);
    console.log(`    ${chalk.cyan('•')} 连接路径：${chalk.white(`${wsPaths.length}个`)} ${chalk.gray(`[${wsPaths.join(', ')}]`)}`);
  }

  console.log(chalk.yellow('\n▶ 性能指标：'));
  console.log(`    ${chalk.cyan('•')} 内存使用：${chalk.white(memMB(memUsage.heapUsed))} / ${chalk.white(memMB(memUsage.heapTotal))}`);
  console.log(`    ${chalk.cyan('•')} RSS内存：${chalk.white(memMB(memUsage.rss))}`);
  console.log(`    ${chalk.cyan('•')} 外部内存：${chalk.white(memMB(memUsage.external))}`);
  const cpuInfo = os.cpus();
  console.log(`    ${chalk.cyan('•')} CPU核心：${chalk.white(`${cpuInfo.length}核`)}`);
  console.log(`    ${chalk.cyan('•')} 平台：${chalk.white(`${process.platform} ${process.arch}`)}`);
  console.log(`    ${chalk.cyan('•')} Node.js：${chalk.white(process.version)}`);

  console.log(chalk.yellow('\n▶ 服务器配置：'));
  const compressionEnabled = runtimeConfig.server.compression?.enabled !== false;
  console.log(`    ${chalk.cyan('•')} 压缩：${compressionEnabled ? chalk.green('已启用') : chalk.gray('已禁用')} ${compressionEnabled ? chalk.gray(`(级别: ${runtimeConfig.server.compression?.level || 6})`) : ''}`);

  const helmetEnabled = runtimeConfig.server.security?.helmet?.enabled !== false;
  console.log(`    ${chalk.cyan('•')} 安全头：${helmetEnabled ? chalk.green('已启用') : chalk.gray('已禁用')}`);

  const corsEnabled = runtimeConfig.server.cors?.enabled !== false;
  console.log(`    ${chalk.cyan('•')} CORS：${corsEnabled ? chalk.green('已启用') : chalk.gray('已禁用')}`);

  const rateLimitEnabled = runtimeConfig.server.rateLimit?.enabled !== false;
  console.log(`    ${chalk.cyan('•')} 速率限制：${rateLimitEnabled ? chalk.green('已启用') : chalk.gray('已禁用')}`);

  const httpsEnabled = runtimeConfig.server.https?.enabled === true;
  console.log(`    ${chalk.cyan('•')} HTTPS：${httpsEnabled ? chalk.green('已启用') : chalk.gray('已禁用')}`);
  if (httpsEnabled && runtimeConfig.server.https?.tls?.http2 === true) {
    console.log(`    ${chalk.cyan('•')} HTTP/2：${chalk.green('已启用')}`);
  }

  const apiList = HttpApiLoader.getApiList();
  const totalRoutes = apiList.reduce((sum: any, api: any) => sum + (api.routes || 0), 0);
  const totalWS = apiList.reduce((sum: any, api: any) => sum + (api.ws || 0), 0);
  const actualWSPaths = Object.keys(runtime.wsf || {}).length;
  console.log(chalk.yellow('\n▶ API统计：'));
  console.log(`    ${chalk.cyan('•')} API模块：${chalk.white(`${apiList.length}个`)}`);
  console.log(`    ${chalk.cyan('•')} HTTP路由：${chalk.white(`${totalRoutes}个`)}`);
  console.log(`    ${chalk.cyan('•')} WebSocket路由：${chalk.white(`${actualWSPaths}个`)} ${actualWSPaths !== totalWS ? chalk.gray(`(API统计: ${totalWS})`) : ''}`);

  const authConfig = runtimeConfig.server.auth || {};
  if (authConfig.apiKey?.enabled !== false) {
    console.log(chalk.yellow('\n▶ 认证配置：'));
    console.log(`    ${chalk.cyan('•')} API密钥：${chalk.white(maskSensitive(runtime.apiKey))}`);
    console.log(chalk.gray('    使用 X-API-Key 请求头进行认证'));
    if (authConfig.loopbackExempt === true) {
      console.log(chalk.red('    ⚠ loopbackExempt=true：满足本机 Host+127 条件时免 Key（公网反代勿开）'));
    } else {
      console.log(chalk.gray('    loopbackExempt=false：所有客户端均须 API Key（推荐）'));
    }
    const wl = Array.isArray(authConfig.whitelist) ? authConfig.whitelist : [];
    if (wl.some((x: any) => String(x || '').trim() === '/' || String(x || '').trim() === '/api' || String(x || '').trim() === '/api*')) {
      console.log(chalk.red('    ⚠ 白名单含「/」或「/api」类危险项，启动时会忽略；请清空后保存'));
    }
  }

  await displayAccessUrls(runtime, 'http', runtime.actualPort);

  console.log(chalk.cyan(`\n${'═'.repeat(60)}\n`));

  RuntimeUtil.makeLog('info', `智能体启动完成 (耗时: ${loadTime}ms)`, '服务器');
  if (wsPaths.length > 0) {
    RuntimeUtil.makeLog('info', `⚡ WebSocket服务：${runtime.getServerUrl().replace(/^http/, 'ws')}/ [${wsPaths.join(', ')}]`, '服务器');
  }
}

/**
 * @param {import('../../agent-runtime.js').default} runtime
 */
export function startTrashCleaner(runtime: any) {
  const miscCfg = runtimeConfig.server?.misc || {};
  const intervalMinutes = Number(miscCfg.trashCleanupIntervalMinutes) || 60;
  const maxAgeHours = Number(miscCfg.trashMaxAgeHours) || 24;

  const intervalMs = Math.max(intervalMinutes, 5) * 60 * 1000;
  const maxAgeMs = Math.max(maxAgeHours, 1) * 60 * 60 * 1000;

  const runCleanup = async () => {
    try {
      await clearTrashOnce(maxAgeMs);
    } catch (err: any) {
      RuntimeUtil.makeLog('debug', `trash 清理失败: ${err.message}`, '服务器');
    }
  };

  runCleanup();
  runtime._trashTimer = setInterval(runCleanup, intervalMs);
}

/**
 * @param {number} maxAgeMs
 */
export async function clearTrashOnce(maxAgeMs: any) {
  const trashRoot = paths.trash;
  if (!trashRoot) return;

  const preserve = Array.isArray(runtimeConfig.server?.misc?.trashPreserve) && runtimeConfig.server.misc.trashPreserve.length
    ? runtimeConfig.server.misc.trashPreserve
    : ['.gitignore', 'instruct.txt'];
  const preserveList = new Set(preserve);

  let entries;
  try {
    entries = await fs.readdir(trashRoot, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  const tasks = entries
    .filter((entry: any) => !preserveList.has(entry.name))
    .map(async (entry: any) => {
      const fullPath = path.join(trashRoot, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        if (now - stat.mtimeMs < maxAgeMs) return;

        await (entry.isDirectory()
          ? fs.rm(fullPath, { recursive: true, force: true })
          : fs.unlink(fullPath));
      } catch {
        // ignore
      }
    });

  await Promise.allSettled(tasks);
}

/**
 * AgentRuntime 启动编排（fail-fast / soft-fail、Loader、listen、online）
 * @param {import('../../agent-runtime.js').default} runtime
 * @param {{ port?: number }} [options]
 */
export async function runAgentRuntime(runtime: any, options: any = {}) {
  const { port } = options;
  const startTime = Date.now();
  const timings: Record<string, number> = {};
  const phase = async (name: any, fn: any) => {
    const t0 = Date.now();
    const result = await fn();
    timings[name] = Date.now() - t0;
    return result;
  };

  runtime._reinitHttpBusiness();

  const proxyConfig = getProxyConfig();
  runtime.proxyEnabled = proxyConfig?.enabled === true;

  runtime.actualPort = port || parseInt(process.env.XRK_SERVER_PORT || '', 10) || 8080;

  const httpsCfg = runtimeConfig.server?.https || {};
  const explicitHttpsPort = Number(httpsCfg.port);
  const httpsPortOffset = Number(httpsCfg.portOffset);
  runtime.actualHttpsPort = (Number.isFinite(explicitHttpsPort) && explicitHttpsPort > 0)
    ? explicitHttpsPort
    : (runtime.actualPort + (Number.isFinite(httpsPortOffset) ? httpsPortOffset : 1));

  if (runtime.proxyEnabled) {
    runtime.httpPort = proxyConfig.httpPort || 80;
    runtime.httpsPort = proxyConfig.httpsPort || 443;
  } else {
    runtime.httpPort = runtime.actualPort;
    runtime.httpsPort = runtime.actualHttpsPort;
  }

  if (runtime.proxyEnabled) {
    await phase('proxyInit', () => runtime._initProxyApp());
  }

  await phase('bootstrapPackages', () => bootstrapRuntimePackages());

  const softFail = process.env.XRK_SOFT_FAIL_STARTUP === '1';

  try {
    await phase('commonConfig', () => CommonConfigRegistry.load());
    setRuntimeGlobal('CommonConfigRegistry', CommonConfigRegistry);
    setRuntimeGlobal('runtimeConfig', runtimeConfig);
  } catch (err: any) {
    RuntimeUtil.makeLog('error', `配置加载失败: ${err?.message}`, '服务器');
    if (!softFail) throw err;
  }

  const [workflowResult, pluginsResult, apiResult] = await phase('loaders', () =>
    Promise.allSettled([
      AiWorkflowLoader.load(),
      (PluginLoader as any).load(),
      HttpApiLoader.load(),
    ])
  );

  const loaderFailures = [
    ['工作流', workflowResult],
    ['插件', pluginsResult],
    ['API', apiResult],
  ].filter(([, r]: any) => r.status === 'rejected');

  for (const [label, result] of loaderFailures) {
    RuntimeUtil.makeLog('error', `${label}加载失败: ${result.reason?.message}`, '服务器');
  }
  if (loaderFailures.length && !softFail) {
    throw loaderFailures[0][1].reason;
  }

  await phase('middleware', () => runtime._initializeMiddlewareAndRoutes());

  await phase('apiRegister', () => HttpApiLoader.register(runtime.express, runtime));
  runtime._setupFinalHandlers();

  await phase('apiKey', () => runtime.generateApiKey());

  const originalHttpPort = runtime.httpPort;
  const originalHttpsPort = runtime.httpsPort;

  if (runtime.proxyEnabled) {
    runtime.httpPort = runtime.actualPort;
    runtime.httpsPort = runtime.actualHttpsPort;
  }

  await phase('httpListen', async () => {
    await runtime.serverLoad(false);
    if (isHttpsEnabled()) {
      await runtime.httpsLoad();
    }
  });

  if (runtime.proxyEnabled) {
    runtime.httpPort = originalHttpPort;
    runtime.httpsPort = originalHttpsPort;
    await phase('proxyListen', () => runtime.startProxyServers());
  }

  await phase('listener', () => ListenerLoader.load(runtime));

  const loadTime = Date.now() - startTime;
  await displayStartupSummary(runtime, loadTime, startTime, timings);

  runtime.emit('online', {
    bot: runtime,
    timestamp: Date.now(),
    url: runtime.getServerUrl(),
    uptime: process.uptime(),
    apis: HttpApiLoader.getApiList(),
    proxyEnabled: runtime.proxyEnabled,
  });

  startTrashCleaner(runtime);
}
