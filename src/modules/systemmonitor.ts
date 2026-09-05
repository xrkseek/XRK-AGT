// @ts-nocheck
/**
 * 系统资源监控单例：内存 / CPU / 磁盘观察，可选本进程 GC。
 *
 * 安全边界见 `#utils/monitor-safety.js`（副作用开关、路径、PID）。
 * 配置模板：`config/default_config/monitor.yaml` → `data/server_bots/monitor.yaml`。
 *
 * @module SystemMonitor
 * @fires SystemMonitor#status
 * @fires SystemMonitor#critical
 * @fires SystemMonitor#leak
 */
import os from 'os';
import v8 from 'v8';
import fs from 'fs/promises';
import path from 'path';
import { exec } from '#utils/exec-async.js';
import EventEmitter from 'events';
import { safeOsNetworkInterfaces } from '#utils/safe-os-network.js';
import { readDisks, readMem } from '#infrastructure/http/utils/system-metrics.js';
import {
    normalizeMonitorConfig,
    isManagedBrowserCommand,
    isSafeKillPid,
    allowedTempRoots,
    allowedLogRoot,
    isPathInsideAllowedRoots,
    isProtectedLogBasename,
    shouldAutoRestartForHeap,
    mayClearOsCache
} from '#utils/monitor-safety.js';

class SystemMonitor extends EventEmitter {
    /** @type {SystemMonitor | null} */
    static instance: any = null;

    /**
     * @returns {SystemMonitor}
     */
    static getInstance(): any {
        if (!SystemMonitor.instance) {
            SystemMonitor.instance = new SystemMonitor();
        }
        return SystemMonitor.instance;
    }

    constructor() {
        super();
        this.isRunning = false;
        this.monitorInterval = null;
        this.reportInterval = null;
        this.lastOptimizeTime = 0;
        /** 防止 checkSystem 重入 */
        this._checking = false;
        /** 防止 optimizeSystem 重入 */
        this._optimizing = false;
        this.browserCache = { data: [], timestamp: 0, ttl: 5000 };
        this.cpuHistory = [];
        this.memoryHistory = [];
        /** 堆泄漏检测状态（启动后由 `config.memory.leakDetection` 覆盖） */
        this.leakDetection = {
            enabled: true,
            threshold: 0.1,
            checkInterval: 300000,
            lastCheck: 0,
            baseline: null,
            growthRate: []
        };
        this.networkStats = { connections: 0 };
        this.fileHandles = { open: 0, max: 0 };
        /** Redis 客户端可选挂载（未就绪则为 null） */
        this.redis = null;
        /** @type {object | null} 经 normalizeMonitorConfig 后的监控配置 */
        this.config = null;
        /** @type {{ total: number, free: number, used: number, usedPercent: number } | null} */
        this._lastSystemMemory = null;
    }

    /**
     * 启动监控（配置经 `normalizeMonitorConfig` 安全合并）。
     *
     * @param {unknown} [config] 原始 `runtimeConfig.monitor`
     * @returns {Promise<void>}
     */
    async start(config) {
        if (this.isRunning) {
            return;
        }

        this.config = normalizeMonitorConfig(config);

        if (!this.config.enabled) {
            return;
        }

        this.isRunning = true;

        const leakConfig = this.config.memory.leakDetection;
        this.leakDetection.enabled = leakConfig.enabled;
        this.leakDetection.threshold = leakConfig.threshold;
        this.leakDetection.checkInterval = leakConfig.checkInterval;

        this._initDatabase().catch(() => {});

        const initialDelay = this.config.initialDelay || 2000;
        setTimeout(() => {
            this.safeRun(async () => {
                await this.checkSystem();
            }, '系统监控首次检查');
        }, initialDelay);

        this.monitorInterval = setInterval(() => {
            this.safeRun(async () => {
                await this.checkSystem();
            }, '系统监控检查');
        }, this.config.interval);
        this.monitorInterval.unref?.();

        if (this.config.report.enabled) {
            this.reportInterval = setInterval(() => {
                this.safeRun(async () => {
                    await this.generateReport();
                }, '系统监控报告生成');
            }, this.config.report.interval);
            this.reportInterval.unref?.();
        }
    }

    /**
     * 停止定时检查与报告，清除运行标记。
     * @returns {void}
     */
    stop() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
        this.isRunning = false;
        logger.info('系统监控已停止');
    }

    /**
     * 延迟挂载 Redis（动态导入，避免循环依赖）。
     * @private
     * @returns {Promise<void>}
     */
    async _initDatabase() {
        try {
            const { getRedis } = await import('#infrastructure/database/index.js');
            const redis = getRedis();
            if (redis) {
                this.redis = redis;
            }
        } catch {
            // Redis 未就绪时忽略
        }
    }

    /**
     * 捕获异步任务异常，避免定时器回调未处理 rejection。
     *
     * @param {() => Promise<void>} task
     * @param {string} [label='系统任务'] 日志前缀
     * @returns {Promise<void>}
     */
    async safeRun(task, label = '系统任务') {
        try {
            await task();
        } catch (error) {
            logger.error(`${label}失败: ${error?.stack || error?.message || error}`);
        }
    }

    /**
     * 单次系统巡检：采样 → 分析 → 按需本进程优化。带 `_checking` 互斥。
     * @returns {Promise<void>}
     */
    async checkSystem() {
        if (!this.isRunning || !this.config?.enabled) {
            return;
        }
        if (this._checking) {
            return;
        }
        this._checking = true;

        try {
            const status = {
                timestamp: Date.now(),
                memory: this.config.memory?.enabled ? await this.checkMemory() : null,
                cpu: this.config.cpu?.enabled ? await this.checkCPU() : null,
                browser: this.config.browser?.enabled ? await this.checkBrowser() : null,
                leak: this.config.memory?.leakDetection?.enabled ? this.detectMemoryLeak() : null,
                disk: this.config.disk?.enabled ? await this.checkDisk() : null,
                network: this.config.network?.enabled ? await this.checkNetwork() : null,
                fileHandles: this.config.system?.enabled ? await this.checkFileHandles() : null
            };

            if (status.leak && this.config.memory?.autoOptimize) {
                logger.warn(`检测到内存泄漏，自动执行优化...`);
                await this.optimizeSystem(status);
            }

            const needOptimize = this.analyzeStatus(status);

            if (needOptimize && this.config.memory?.autoOptimize) {
                await this.optimizeSystem(status);
            }

            this.emit('status', status);
        } catch (error) {
            logger.error(`系统检查失败: ${error.message}`);
        } finally {
            this._checking = false;
        }
    }

    /**
     * 采样 Node 堆与整机内存。
     * `warning` 仅表示堆压力；整机高压写入 `systemWarning`，不单独驱动 GC。
     *
     * @returns {Promise<object>}
     */
    async checkMemory() {
        const processMemory = process.memoryUsage();
        const mem = await readMem();
        const systemMemory = {
            total: mem.total,
            free: mem.free,
            used: mem.used,
            usedPercent: mem.total > 0 ? (mem.used / mem.total) * 100 : 0,
        };
        this._lastSystemMemory = systemMemory;
        const heapStats = v8.getHeapStatistics();
        
        const heapUsedPercent = (processMemory.heapUsed / heapStats.heap_size_limit) * 100;
        const systemUsedPercent = systemMemory.usedPercent;

        this.memoryHistory.push({
            timestamp: Date.now(),
            heapUsed: processMemory.heapUsed,
            systemUsed: systemMemory.used
        });

        if (this.memoryHistory.length > 50) {
            this.memoryHistory.shift();
        }

        const nodePressure = heapUsedPercent > (this.config?.memory?.nodeThreshold || 85);
        const systemPressure = systemUsedPercent > (this.config?.memory?.systemThreshold || 85);

        return {
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: processMemory.rss,
                heapUsedPercent
            },
            system: {
                total: systemMemory.total,
                used: systemMemory.used,
                free: systemMemory.free,
                usedPercent: systemUsedPercent
            },
            warning: nodePressure,
            systemWarning: systemPressure
        };
    }

    /**
     * 采样本进程 CPU（短窗口差分）。
     * @returns {Promise<object | null>}
     */
    async checkCPU() {
        if (!this.config.cpu?.enabled) return null;

        const startUsage = process.cpuUsage();
        const startTime = Date.now();
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const endUsage = process.cpuUsage(startUsage);
        const elapsedTime = Date.now() - startTime;
        
        const cpuPercent = ((endUsage.user + endUsage.system) / 1000 / elapsedTime) * 100;
        const loadAvg = os.loadavg();

        this.cpuHistory.push({ timestamp: Date.now(), usage: cpuPercent });
        if (this.cpuHistory.length > 30) this.cpuHistory.shift();

        return {
            usage: cpuPercent,
            loadAvg: loadAvg[0],
            cores: os.cpus().length,
            warning: cpuPercent > this.config.cpu?.threshold
        };
    }

    /**
     * 浏览器进程巡检；超限时仅清理托管实例（见 `cleanupBrowsers`）。
     * @returns {Promise<object | null>}
     */
    async checkBrowser() {
        if (!this.config.browser?.enabled) {
            return null;
        }

        const now = Date.now();
        if (this.browserCache.data.length > 0 && 
            (now - this.browserCache.timestamp) < this.browserCache.ttl) {
            return { processes: this.browserCache.data, fromCache: true };
        }

        const processes = await this.detectBrowserProcesses();
        const maxInstances = this.config.browser?.maxInstances || 5;
        const needCleanup = processes.length > maxInstances;

        if (needCleanup) {
            logger.warn(`检测到浏览器进程过多 (${processes.length}/${maxInstances})，执行清理...`);
            await this.cleanupBrowsers(processes);
            const remainingProcesses = await this.detectBrowserProcesses();
            this.browserCache = { data: remainingProcesses, timestamp: now, ttl: 5000 };
            
            return {
                count: remainingProcesses.length,
                processes: remainingProcesses,
                needCleanup: false,
                warning: false,
                cleaned: processes.length - remainingProcesses.length
            };
        }

        this.browserCache = { data: processes, timestamp: now, ttl: 5000 };

        return {
            count: processes.length,
            processes,
            needCleanup: false,
            warning: false
        };
    }

    /**
     * 枚举本机 Chrome / Edge / Chromium 相关进程（平台相关 shell）。
     * @returns {Promise<Array<{ pid: number, startTime: number, command: string }>>}
     */
    async detectBrowserProcesses() {
        const platform = process.platform;
        let command = '';

        if (platform === 'win32') {
            command = 'wmic process where "name=\'chrome.exe\' or name=\'msedge.exe\'" get processid,creationdate,commandline /format:csv';
        } else if (platform === 'darwin') {
            command = 'ps -ax -o pid,etime,command | grep -E "(Chrome|Edge)" | grep -v grep | grep -v Helper';
        } else {
            command = 'ps -eo pid,etime,cmd | grep -E "(chrome|chromium|msedge)" | grep -v grep | grep -v "type="';
        }

        try {
            const { stdout } = await exec(command);
            return this.parseBrowserProcesses(stdout, platform);
        } catch {
            return [];
        }
    }

    /**
     * 解析 `detectBrowserProcesses` 的 stdout。
     *
     * @param {string} output
     * @param {NodeJS.Platform} platform
     * @returns {Array<{ pid: number, startTime: number, command: string }>}
     */
    parseBrowserProcesses(output, platform) {
        const processes = [];
        const lines = output.split('\n').filter(line => line.trim());

        for (const line of lines) {
            try {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 2) continue;

                const pid = parseInt(parts[0], 10);
                if (isNaN(pid)) continue;

                if (line.includes('--type=') && !line.includes('--type=browser')) continue;
                if (line.includes('Helper') || line.includes('renderer')) continue;

                let startTime = Date.now();
                const timeStr = parts[1];
                if (platform === 'win32') {
                    if (timeStr && timeStr.length >= 14) {
                        try {
                            const year = parseInt(timeStr.substring(0, 4));
                            const month = parseInt(timeStr.substring(4, 6)) - 1;
                            const day = parseInt(timeStr.substring(6, 8));
                            const hour = parseInt(timeStr.substring(8, 10));
                            const minute = parseInt(timeStr.substring(10, 12));
                            startTime = new Date(year, month, day, hour, minute).getTime();
                        } catch {
                            // 保留 Date.now() 默认
                        }
                    }
                } else {
                    const timeParts = timeStr.split(/[-:]/);
                    if (timeParts.length === 2) {
                        startTime = Date.now() - (parseInt(timeParts[0]) * 60 + parseInt(timeParts[1])) * 1000;
                    } else if (timeParts.length === 3) {
                        startTime = Date.now() - (parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseInt(timeParts[2])) * 1000;
                    }
                }

                processes.push({
                    pid,
                    startTime,
                    command: line
                });
            } catch {
                continue;
            }
        }

        return processes.sort((a, b) => b.startTime - a.startTime);
    }

    /**
     * 结束超量托管浏览器进程（`isManagedBrowserCommand` + `isSafeKillPid`）。
     *
     * @param {Array<{ pid: number, startTime: number, command: string }>} processes
     * @returns {Promise<number>} 成功结束的进程数
     */
    async cleanupBrowsers(processes) {
        const managed = processes.filter((p) => this._isManagedBrowserCommand(p.command || ''));
        if (managed.length === 0) {
            logger.debug('浏览器实例偏多，但无 AGT 托管进程可清理，已跳过 taskkill');
            return 0;
        }

        const maxInstances = this.config.browser?.maxInstances || 5;
        const reserveNewest = this.config.browser?.reserveNewest !== false;
        const sortedProcesses = [...managed].sort((a, b) => b.startTime - a.startTime);
        const toRemove = reserveNewest
            ? sortedProcesses.slice(maxInstances)
            : sortedProcesses.slice(0, Math.max(0, sortedProcesses.length - maxInstances));

        if (toRemove.length === 0) {
            return 0;
        }

        let cleaned = 0;
        await Promise.allSettled(toRemove.map(async (proc) => {
            try {
                if (!isSafeKillPid(proc.pid)) return;
                const cmd = process.platform === 'win32'
                    ? `taskkill /F /PID ${proc.pid}`
                    : `kill -15 ${proc.pid}`;
                await exec(cmd);
                cleaned++;
            } catch (e) {
                const msg = e?.message || '';
                if (msg.includes('not found') || msg.includes('No such process')) cleaned++;
            }
        }));

        if (cleaned > 0) {
            logger.info(`已清理 ${cleaned} 个托管浏览器进程 (保留最多 ${maxInstances} 个)`);
        }
        return cleaned;
    }

    /**
     * @param {string} commandLine
     * @returns {boolean}
     * @private
     */
    _isManagedBrowserCommand(commandLine) {
        return isManagedBrowserCommand(commandLine);
    }

    /**
     * 分析巡检结果：返回是否应对本进程做 autoOptimize。
     * 整机内存仅 debug；`autoRestart` 仅看 Node 堆（`shouldAutoRestartForHeap`）。
     *
     * @param {object} status `checkSystem` 汇总对象
     * @returns {boolean}
     */
    analyzeStatus(status) {
        const issues = [];

        if (status.memory?.warning) {
            issues.push('memory');
        } else if (status.memory?.systemWarning) {
            logger.debug(
                `整机内存偏高 ${status.memory.system.usedPercent.toFixed(1)}%，Node 堆正常，跳过自动优化`
            );
        }

        if (status.cpu?.warning) {
            issues.push('cpu');
        }

        if (status.browser?.warning) {
            issues.push('browser');
        }

        if (status.disk?.usedPercent > 90) {
            issues.push('disk');
            logger.warn(`磁盘使用率过高: ${status.disk.usedPercent.toFixed(1)}%`);
        }

        if (status.network?.warning) {
            issues.push('network');
            logger.warn(`网络连接数过多: ${status.network.connections}`);
        }

        if (status.fileHandles?.warning) {
            issues.push('fileHandles');
            logger.warn(`文件句柄使用率过高: ${status.fileHandles.usagePercent.toFixed(1)}%`);
        }

        if (shouldAutoRestartForHeap(status.memory?.process, this.config.optimize)) {
            logger.error(
                `Node 堆超过 ${this.config.optimize.restartThreshold}%，触发 critical（autoRestart）`
            );
            this.emit('critical', { type: 'memory', status });
        }

        return issues.length > 0;
    }

    /**
     * 相对基线检测堆持续增长；命中时 emit `leak` 并返回摘要。
     * @returns {{ growth: number, current: number, baseline: number, growthPercent: number } | null}
     */
    detectMemoryLeak() {
        if (!this.leakDetection.enabled) return null;
        
        const now = Date.now();
        if (now - this.leakDetection.lastCheck < this.leakDetection.checkInterval) {
            return null;
        }
        
        const currentMem = process.memoryUsage();
        const heapUsed = currentMem.heapUsed;

        if (!this.leakDetection.baseline) {
            this.leakDetection.baseline = heapUsed;
            this.leakDetection.lastCheck = now;
            return null;
        }

        const growth = (heapUsed - this.leakDetection.baseline) / this.leakDetection.baseline;
        this.leakDetection.growthRate.push({
            timestamp: now,
            growth: growth,
            heapUsed: heapUsed
        });

        if (this.leakDetection.growthRate.length > 10) {
            this.leakDetection.growthRate.shift();
        }

        const recentGrowth = this.leakDetection.growthRate.slice(-5);
        const avgGrowth = recentGrowth.reduce((sum, r) => sum + r.growth, 0) / recentGrowth.length;

        this.leakDetection.lastCheck = now;

        if (avgGrowth > this.leakDetection.threshold) {
            const growthPercent = (avgGrowth * 100).toFixed(2);
            logger.warn(`⚠️ 检测到潜在内存泄漏: 内存增长 ${growthPercent}%`);
            this.emit('leak', {
                growth: avgGrowth,
                baseline: this.leakDetection.baseline,
                current: heapUsed,
                history: this.leakDetection.growthRate
            });
            return {
                growth: avgGrowth,
                current: heapUsed,
                baseline: this.leakDetection.baseline,
                growthPercent: parseFloat(growthPercent)
            };
        }

        return null;
    }

    /**
     * 采样主磁盘使用率（与 HTTP / #状态 同一套 normalizeDisks）。
     * @returns {Promise<{ total: number, free: number, used: number, usedPercent: number } | null>}
     */
    async checkDisk() {
        try {
            const main = (await readDisks())[0];
            if (!main?.size) {
                return { total: 0, free: 0, used: 0, usedPercent: 0 };
            }
            const free = Math.max(0, main.size - main.used);
            return {
                total: main.size,
                free,
                used: main.used,
                usedPercent: (main.used / main.size) * 100,
            };
        } catch {
            return null;
        }
    }

    /**
     * 采样 ESTABLISHED 连接数（失败时用网卡数估算）。
     * @returns {Promise<{ connections: number, warning: boolean }>}
     */
    async checkNetwork() {
        try {
            const platform = process.platform;
            let connections = 0;

            if (platform === 'win32') {
                try {
                    const { stdout } = await exec('netstat -an | find /c "ESTABLISHED"');
                    connections = parseInt(stdout.trim()) || 0;
                } catch {
                    connections = this._estimateNetworkConnections();
                }
            } else if (platform === 'linux' || platform === 'darwin') {
                try {
                    const { stdout } = await exec('netstat -an 2>/dev/null | grep ESTABLISHED | wc -l || ss -an 2>/dev/null | grep ESTAB | wc -l || echo 0');
                    connections = parseInt(stdout.trim()) || 0;
                } catch {
                    connections = this._estimateNetworkConnections();
                }
            } else {
                connections = this._estimateNetworkConnections();
            }

            this.networkStats.connections = connections;

            return {
                connections,
                warning: connections > (this.config.network?.maxConnections || 1000)
            };
        } catch {
            return {
                connections: 0,
                warning: false
            };
        }
    }

    /**
     * netstat 不可用时的连接数粗算（网卡数 × 10）。
     * @returns {number}
     * @private
     */
    _estimateNetworkConnections() {
        return Object.keys(safeOsNetworkInterfaces()).length * 10;
    }

    /**
     * 采样本进程打开文件句柄数 / 上限。
     * @returns {Promise<{ open: number, max: number, usagePercent: number, warning: boolean } | null>}
     */
    async checkFileHandles() {
        try {
            const platform = process.platform;
            const pid = process.pid;
            let openHandles = 0;
            let maxHandles = 0;

            if (platform === 'linux') {
                maxHandles = await this._getFileHandleLimit() || 1024;
                openHandles = await this._getLinuxFileHandles(pid) || 0;
            } else if (platform === 'win32') {
                maxHandles = 2048;
                openHandles = await this._getWindowsFileHandles(pid) || 0;
            } else if (platform === 'darwin') {
                maxHandles = await this._getFileHandleLimit() || 1024;
                openHandles = await this._getDarwinFileHandles(pid) || 0;
            } else {
                maxHandles = 1024;
                openHandles = 0;
            }

            this.fileHandles.open = openHandles;
            this.fileHandles.max = maxHandles;

            return {
                open: openHandles,
                max: maxHandles,
                usagePercent: maxHandles > 0 ? (openHandles / maxHandles * 100) : 0,
                warning: maxHandles > 0 && (openHandles / maxHandles) > 0.8
            };
        } catch {
            return null;
        }
    }

    /**
     * @returns {Promise<number>}
     * @private
     */
    async _getFileHandleLimit() {
        try {
            const { stdout } = await exec(`ulimit -n 2>/dev/null || echo 1024`);
            return parseInt(stdout.trim()) || 1024;
        } catch {
            return 1024;
        }
    }

    /**
     * @param {number} pid
     * @returns {Promise<number>}
     * @private
     */
    async _getLinuxFileHandles(pid) {
        try {
            const { stdout } = await exec(`lsof -p ${pid} 2>/dev/null | wc -l`);
            return parseInt(stdout.trim()) || 0;
        } catch {
            try {
                const { stdout } = await exec(`ls /proc/${pid}/fd 2>/dev/null | wc -l`);
                return parseInt(stdout.trim()) || 0;
            } catch {
                return 0;
            }
        }
    }

    /**
     * @param {number} pid
     * @returns {Promise<number>}
     * @private
     */
    async _getWindowsFileHandles(pid) {
        try {
            const { stdout } = await exec(`handle.exe -p ${pid} 2>nul | find /c "File"`);
            return parseInt(stdout.trim()) || 0;
        } catch {
            return 0;
        }
    }

    /**
     * @param {number} pid
     * @returns {Promise<number>}
     * @private
     */
    async _getDarwinFileHandles(pid) {
        try {
            const { stdout } = await exec(`lsof -p ${pid} 2>/dev/null | wc -l`);
            return parseInt(stdout.trim()) || 0;
        } catch {
            return 0;
        }
    }

    /**
     * 本进程优化入口：始终 `optimizeMemory`；仅磁盘占用 >90% 且显式清理开关才删文件。
     * flushdns / chrt / wmic 优先级不在此路径触发。
     *
     * @param {object | null} [status] 含 `disk.usedPercent` 时供磁盘清理门控
     * @returns {Promise<void>}
     */
    async optimizeSystem(status = null) {
        if (this._optimizing) return;
        const now = Date.now();
        const gcInterval = this.config.memory?.gcInterval || 600000;

        if (now - this.lastOptimizeTime < gcInterval) {
            return;
        }

        this._optimizing = true;
        this.lastOptimizeTime = now;
        logger.debug('执行系统优化...');

        try {
            await this.optimizeMemory();

            const diskPct = Number(status?.disk?.usedPercent);
            const mayCleanDisk =
                Number.isFinite(diskPct) &&
                diskPct > 90 &&
                (this.config.disk?.cleanupTemp === true || this.config.disk?.cleanupLogs === true);
            if (mayCleanDisk) {
                await this.optimizeDisk();
            }

            logger.debug('系统优化完成');
        } catch (error) {
            logger.error(`系统优化失败: ${error.message}`);
        } finally {
            this._optimizing = false;
        }
    }

    /**
     * 本进程 GC（需 `--expose-gc`）并收缩内部采样缓存。
     * @returns {Promise<void>}
     */
    async optimizeMemory() {
        const leakInfo = this.detectMemoryLeak();
        if (leakInfo) {
            logger.warn(`内存泄漏检测: 当前 ${(leakInfo.current / 1024 / 1024).toFixed(2)}MB, 基线 ${(leakInfo.baseline / 1024 / 1024).toFixed(2)}MB`);
        }

        const beforeMem = process.memoryUsage();

        if (global.gc) {
            global.gc();
            await new Promise(resolve => setTimeout(resolve, 100));

            if (this.config.optimize?.aggressive) {
                await new Promise(resolve => setTimeout(resolve, 500));
                global.gc();
            }
        }

        this.browserCache = { data: [], timestamp: 0, ttl: 5000 };
        this.cpuHistory = this.cpuHistory.slice(-10);
        this.memoryHistory = this.memoryHistory.slice(-10);

        const afterMem = process.memoryUsage();
        const freed = beforeMem.heapUsed - afterMem.heapUsed;
        
        if (freed > 0) {
            logger.debug(`内存优化: 释放 ${(freed / 1024 / 1024).toFixed(2)}MB`);
        }
        
        if (afterMem.heapUsed < this.leakDetection.baseline * 0.9) {
            this.leakDetection.baseline = afterMem.heapUsed;
            this.leakDetection.growthRate = [];
        }
    }

    /**
     * 按开关清理 temp / 日志（路径边界见 `#utils/monitor-safety`）。
     * @returns {Promise<void>}
     */
    async optimizeDisk() {
        try {
            if (this.config.disk?.cleanupTemp === true) {
                await this.cleanupTempFiles();
            }
            if (this.config.disk?.cleanupLogs === true) {
                await this.cleanupLogFiles();
            }
        } catch (error) {
            logger.error(`磁盘优化失败: ${error.message}`);
        }
    }

    /**
     * 删除 `allowedTempRoots()` 下超过 `tempMaxAge` 的普通文件。
     * @returns {Promise<void>}
     */
    async cleanupTempFiles() {
        try {
            const roots = allowedTempRoots();
            const maxAge = this.config.disk?.tempMaxAge || 86400000;
            const now = Date.now();
            let cleaned = 0;
            let freed = 0;

            for (const dir of roots) {
                try {
                    const files = await fs.readdir(dir, { withFileTypes: true });
                    for (const file of files) {
                        if (!file.isFile()) continue;
                        const filePath = path.join(dir, file.name);
                        if (!(await isPathInsideAllowedRoots(filePath, roots))) continue;
                        try {
                            const stats = await fs.stat(filePath);
                            if (now - stats.mtimeMs > maxAge) {
                                const size = stats.size;
                                await fs.unlink(filePath);
                                cleaned++;
                                freed += size;
                            }
                        } catch {
                            // 单文件失败跳过
                        }
                    }
                } catch {
                    // 目录不存在跳过
                }
            }

            if (cleaned > 0) {
                logger.debug(`清理临时文件: ${cleaned} 个，释放 ${(freed / 1024 / 1024).toFixed(2)}MB`);
            }
        } catch (error) {
            logger.error(`清理临时文件失败: ${error.message}`);
        }
    }

    /**
     * 删除 `logs/` 下过期或超大的 `.log`；跳过 `PROTECTED_LOG_BASENAMES`。
     * @returns {Promise<void>}
     */
    async cleanupLogFiles() {
        try {
            const logDir = allowedLogRoot();
            const maxAge = this.config.disk?.logMaxAge || 604800000;
            const maxSize = this.config.disk?.maxLogSize || 100 * 1024 * 1024;
            const now = Date.now();
            let cleaned = 0;
            let freed = 0;

            try {
                const files = await fs.readdir(logDir, { withFileTypes: true });
                const logFiles = files.filter(f => f.isFile() && f.name.endsWith('.log'));

                for (const file of logFiles) {
                    if (isProtectedLogBasename(file.name)) continue;
                    const filePath = path.join(logDir, file.name);
                    if (!(await isPathInsideAllowedRoots(filePath, [logDir]))) continue;
                    try {
                        const stats = await fs.stat(filePath);
                        const shouldDelete = (now - stats.mtimeMs > maxAge) || (stats.size > maxSize);
                        if (shouldDelete) {
                            const size = stats.size;
                            await fs.unlink(filePath);
                            cleaned++;
                            freed += size;
                        }
                    } catch {
                        // 单文件失败跳过
                    }
                }

                if (cleaned > 0) {
                    logger.debug(`清理日志: ${cleaned} 个，释放 ${(freed / 1024 / 1024).toFixed(2)}MB`);
                }
            } catch {
                // 目录不存在跳过
            }
        } catch (error) {
            logger.error(`清理日志文件失败: ${error.message}`);
        }
    }

    /**
     * OS 缓存清理（须 `mayClearOsCache`；默认巡检路径不调用）。
     * @returns {Promise<void>}
     */
    async clearSystemCache() {
        if (!mayClearOsCache(this.config)) return;
        try {
            const platform = process.platform;
            const cacheCommands = {
                linux: ['sync'],
                win32: ['ipconfig /flushdns'],
                darwin: []
            };

            const commands = cacheCommands[platform] || [];
            for (const cmd of commands) {
                try {
                    await exec(cmd);
                } catch {
                    // 权限不足或命令失败跳过
                }
            }
            if (commands.length) logger.debug('系统缓存清理命令已执行');
        } catch {
            // 整段失败忽略
        }
    }

    /**
     * Linux `chrt` 调度微调（须 `system.optimizeCPU`；默认巡检不调用）。
     * @returns {Promise<void>}
     */
    async optimizeSystemLevel() {
        try {
            if (this.config.system?.optimizeCPU && process.platform === 'linux') {
                try {
                    await exec(`chrt -r -p 0 ${process.pid} 2>/dev/null || true`);
                    logger.info('  ✓ 已优化CPU调度策略');
                } catch {
                    // 权限不足跳过
                }
            }
        } catch {
            // 整段失败忽略
        }
    }

    /**
     * 调整本进程优先级（须 `process.enabled`；默认巡检不调用）。
     * @returns {Promise<void>}
     */
    async optimizeProcess() {
        try {
            const platform = process.platform;
            const priority = this.config.process?.priority || 'normal';
            const nice = this.config.process?.nice || 0;

            if (platform === 'linux') {
                if (nice !== 0) {
                    try {
                        process.setPriority(nice);
                        logger.info(`  ✓ 已设置进程优先级 (nice: ${nice})`);
                    } catch {
                        // 权限不足跳过
                    }
                }
            } else if (platform === 'win32') {
                const priorityMap = {
                    low: 'below normal',
                    normal: 'normal',
                    high: 'above normal'
                };
                const winPriority = priorityMap[priority] || 'normal';
                try {
                    await exec(`wmic process where processid=${process.pid} set priority="${winPriority}"`);
                    logger.info(`  ✓ 已设置进程优先级 (${priority})`);
                } catch {
                    // wmic 失败跳过
                }
            }
        } catch {
            // 整段失败忽略
        }
    }

    /**
     * 周期报告：常规 `debug` 一行；堆超阈值时 `warn`。
     * @returns {Promise<void>}
     */
    async generateReport() {
        const memory = this.getSystemMemory();
        const processMemory = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        const heapPct = (processMemory.heapUsed / heapStats.heap_size_limit) * 100;
        const line = `监控 ${this.formatUptime(process.uptime())} | 系统 ${memory.usedPercent.toFixed(1)}% | Node堆 ${this.formatBytes(processMemory.heapUsed)} (${heapPct.toFixed(1)}%)`;
        if (heapPct > (this.config.memory?.nodeThreshold || 85)) {
            logger.warn(line);
        } else {
            logger.debug(line);
        }
    }

    /**
     * @returns {{ total: number, free: number, used: number, usedPercent: number }}
     */
    getSystemMemory() {
        if (this._lastSystemMemory) return this._lastSystemMemory;
        const total = os.totalmem();
        const free = os.freemem();
        const used = Math.max(0, total - free);
        return {
            total,
            free,
            used,
            usedPercent: total > 0 ? (used / total) * 100 : 0,
        };
    }

    /**
     * @param {number} bytes
     * @returns {string}
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
    }

    /**
     * @param {number} seconds 进程 uptime
     * @returns {string} 如 `1天2时3分`
     */
    formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const parts = [];
        if (d > 0) parts.push(`${d}天`);
        if (h > 0) parts.push(`${h}时`);
        if (m > 0) parts.push(`${m}分`);
        return parts.join('') || '< 1分';
    }
}

export default SystemMonitor;