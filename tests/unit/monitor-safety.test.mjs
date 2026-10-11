/**
 * `#utils/monitor-safety` 企业安全边界单测（缺省关副作用、路径/PID/堆门控）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normalizeMonitorConfig,
  isManagedBrowserCommand,
  isSafeKillPid,
  allowedTempRoots,
  isPathInsideAllowedRoots,
  isProtectedLogBasename,
  shouldAutoRestartForHeap,
  mayClearOsCache
} from '#utils/monitor-safety.js';

describe('monitor-safety', () => {
  it('缺省配置：危险开关全部关闭', () => {
    const c = normalizeMonitorConfig({});
    assert.equal(c.browser.enabled, false);
    assert.equal(c.network.enabled, false);
    assert.equal(c.process.enabled, false);
    assert.equal(c.system.enabled, false);
    assert.equal(c.system.clearCache, false);
    assert.equal(c.system.optimizeCPU, false);
    assert.equal(c.disk.cleanupTemp, false);
    assert.equal(c.disk.cleanupLogs, false);
    assert.equal(c.optimize.aggressive, false);
    assert.equal(c.optimize.autoRestart, false);
  });

  it('旧 yaml 「!== false」风格危险项仍被关掉', () => {
    const c = normalizeMonitorConfig({
      browser: {},
      network: {},
      process: {},
      system: {},
      disk: { enabled: true },
      optimize: {}
    });
    assert.equal(c.browser.enabled, false);
    assert.equal(c.network.enabled, false);
    assert.equal(c.process.enabled, false);
    assert.equal(c.system.clearCache, false);
    assert.equal(c.disk.cleanupTemp, false);
  });

  it('仅识别托管浏览器命令行', () => {
    assert.equal(isManagedBrowserCommand('chrome.exe --headless --user-data-dir=C:\\temp\\x'), true);
    assert.equal(isManagedBrowserCommand('C:\\Program Files\\Google\\Chrome\\chrome.exe'), false);
  });

  it('拒绝自杀 / 杀父进程 PID', () => {
    assert.equal(isSafeKillPid(process.pid), false);
    if (process.ppid) assert.equal(isSafeKillPid(process.ppid), false);
    assert.equal(isSafeKillPid(0), false);
    assert.equal(isSafeKillPid(12345), true);
  });

  it('temp 根仅 data/temp', () => {
    const roots = allowedTempRoots('/app');
    assert.deepEqual(roots, [path.resolve('/app', 'data', 'temp')]);
  });

  it('路径不得跳出允许根', async () => {
    const root = allowedTempRoots(process.cwd())[0];
    const inside = path.join(root, 'a.tmp');
    const outside = path.join(process.cwd(), 'data', 'uploads', 'secret.bin');
    assert.equal(await isPathInsideAllowedRoots(inside, [root]), true);
    assert.equal(await isPathInsideAllowedRoots(outside, [root]), false);
  });

  it('保护活跃日志名', () => {
    assert.equal(isProtectedLogBasename('app.log'), true);
    assert.equal(isProtectedLogBasename('trace.log'), true);
    assert.equal(isProtectedLogBasename('old-rotated.log'), false);
  });

  it('autoRestart 只用 Node 堆，不用整机内存', () => {
    assert.equal(
      shouldAutoRestartForHeap({ heapUsedPercent: 96 }, { autoRestart: true, restartThreshold: 95 }),
      true
    );
    assert.equal(
      shouldAutoRestartForHeap({ heapUsedPercent: 50 }, { autoRestart: true, restartThreshold: 95 }),
      false
    );
    assert.equal(
      shouldAutoRestartForHeap({ heapUsedPercent: 99 }, { autoRestart: false, restartThreshold: 95 }),
      false
    );
  });

  it('Windows flushdns 须 clearCache + aggressive', () => {
    assert.equal(mayClearOsCache({ system: { clearCache: true }, optimize: { aggressive: false } }, 'win32'), false);
    assert.equal(mayClearOsCache({ system: { clearCache: true }, optimize: { aggressive: true } }, 'win32'), true);
    assert.equal(mayClearOsCache({ system: { clearCache: true }, optimize: { aggressive: false } }, 'linux'), true);
  });
});
