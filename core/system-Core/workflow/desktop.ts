// @ts-nocheck
import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import RuntimeUtil from '#utils/runtime-util.js';
import paths from '#utils/paths.js';
import { exec as execCb, spawn } from 'child_process';
import { exec } from '#utils/exec-async.js';
import path from 'path';
import fs from 'fs/promises';
import { BaseTools } from '#utils/base-tools.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { resolveConfiguredWorkspace, ensureAgentWorkspaceSync, getConfiguredDefaultWorkspaceId } from '../lib/ai-workspace-runtime.js';
import si from 'systeminformation';
import {
  buildAgtUserContent,
  extractVisionFromSegments,
  visionRefToLocator
} from '#utils/llm/vision-content.js';

const IS_WINDOWS = process.platform === 'win32';
const IS_DARWIN = process.platform === 'darwin';
const execCommand = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    execCb(command, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      resolve(stdout ?? '');
    });
  });
};

/**
 * 桌面与通用助手工作流
 * 
 * 所有功能都通过 MCP 工具提供：
 * - 系统：show_desktop、open_system_tool、lock_screen、power_control、get_time
 * - 打开：open_application、open_browser、open_path（建目录用 tools.run）
 * - 信息：screenshot、system_info、disk_space（列文件用 tools.list_files）
 * - 进程：cleanup_processes（Shell 命令用 tools.run）
 * - 剪贴板：read_clipboard、write_clipboard
 * - 办公文档：tools.run + office-* skills
 */
export default class DesktopStream extends AiWorkflow {

  constructor() {
    super({
      name: 'desktop',
      description: '桌面与通用助手工作流',
      version: '2.1.0',
      author: 'XRK',
      priority: 100,
      config: {
        enabled: true,
        temperature: 0.8,
        maxTokens: 4000,
        topP: 0.9,
        presencePenalty: 0.6,
        frequencyPenalty: 0.6
      },
      embedding: { enabled: true }
    });

    this.workspace = ensureAgentWorkspaceSync(getConfiguredDefaultWorkspaceId());
    this.tools = null;
  }

  applyWorkspaceConfig() {
    const fileCfg = getAiWorkflowConfigOptional().tools?.file ?? {};
    this.workspace = resolveConfiguredWorkspace(fileCfg.workspace);
    this.tools = new BaseTools(this.workspace);
  }

  /**
   * 获取工作区路径
   */
  getWorkspace() {
    return this.workspace;
  }

  async init() {
    this.applyWorkspaceConfig();
    await super.init();
    this.registerAllFunctions();
  }

  /** 使用系统默认方式打开文件或目录（Windows 用 start，macOS/Linux 用 open/xdg-open） */
  async openPathDetached(fullPath) {
    const resolved = path.resolve(fullPath);
    if (IS_WINDOWS) {
      const escaped = resolved.replace(/"/g, '""');
      await exec(`start "" "${escaped}"`, { shell: 'cmd.exe', timeout: 20000 });
      return;
    }
    const bin = IS_DARWIN ? 'open' : 'xdg-open';
    await new Promise((resolve, reject) => {
      const child = spawn(bin, [resolved], { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.unref();
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${bin} 退出码 ${code}`))));
    });
  }

  /**
   * 统一参数获取：支持多种参数名（兼容MCP工具和内部调用）
   */
  getParam(params, ...keys) {
    if (!params) return;
    for (const key of keys) {
      if (params[key] !== undefined) {
        return params[key];
      }
    }
    return;
  }

  /**
   * 统一文件名安全处理
   */
  sanitizeFileName(fileName) {
    if (!fileName) return '';
    return fileName.replace(/[<>:"/\\|?*]/g, '_');
  }


  /**
   * 注册所有MCP工具
   */
  registerAllFunctions() {
    this.registerMCPTool('show_desktop', {
      description:
        '显示桌面/最小化窗口：Windows 用 Shell 最小化全部；macOS 尝试 Mission Control 快捷键；Linux 优先 wmctrl，其次 xdotool（需已安装）。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        try {
          if (IS_WINDOWS) {
            await exec('powershell -NoProfile -Command "(New-Object -ComObject shell.application).MinimizeAll()"', {
              timeout: 8000
            });
            return this.successResponse({ message: '已回到桌面', platform: 'win32' });
          }
          if (IS_DARWIN) {
            try {
              await exec(
                `osascript -e 'tell application "System Events" to keystroke "d" using {command down, fn down}'`,
                { timeout: 5000 }
              );
            } catch {
              await exec(`osascript -e 'tell application "System Events" to key code 103'`, { timeout: 5000 });
            }
            return this.successResponse({
              message: '已尝试显示桌面（若无效请在「系统设置 → 键盘」中确认 Mission Control/显示桌面快捷键）',
              platform: 'darwin'
            });
          }
          try {
            await exec('wmctrl -k on', { timeout: 5000 });
            return this.successResponse({ message: '已切换展示桌面（wmctrl）', platform: 'linux' });
          } catch {
            await exec('xdotool key Super_L+d', { timeout: 5000 });
            return this.successResponse({ message: '已发送显示桌面快捷键（xdotool）', platform: 'linux' });
          }
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] show_desktop: ${err.message}`, 'DesktopStream');
          return this.errorResponse(
            'SHOW_DESKTOP_FAILED',
            `${err.message}（Linux 可安装 wmctrl 或 xdotool；Wayland 下可能需桌面环境自带快捷键）`
          );
        }
      },
      enabled: true
    });

    this.registerMCPTool('open_system_tool', {
      description:
        '打开系统常用工具。逻辑名统一为 notepad / calc / taskmgr：Windows 对应记事本、计算器、任务管理器；macOS 为 TextEdit、Calculator、Activity Monitor；Linux 依次尝试 gedit|nano、gnome-calculator|xcalc、gnome-system-monitor|htop 等。',
      inputSchema: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: '工具名称',
            enum: ['notepad', 'calc', 'taskmgr']
          }
        },
        required: ['tool']
      },
      handler: async (args = {}, _context = {}) => {
        const { tool } = args;
        if (!tool) {
          return this.errorResponse('INVALID_PARAM', '工具名称不能为空');
        }

        const toolNames = { notepad: '记事本/编辑器', calc: '计算器', taskmgr: '任务管理器/监视器' };

        try {
          if (IS_WINDOWS) {
            await execCommand(`start "" ${tool}`, { shell: 'cmd.exe' });
            return this.successResponse({
              message: `已打开${toolNames[tool] || '应用'}`,
              tool: toolNames[tool] || tool,
              platform: 'win32'
            });
          }
          if (IS_DARWIN) {
            const appMap = { notepad: 'TextEdit', calc: 'Calculator', taskmgr: 'Activity Monitor' };
            const app = appMap[tool];
            await exec(`open -a "${app.replace(/"/g, '\\"')}"`, { timeout: 15000 });
            return this.successResponse({
              message: `已打开 ${app}`,
              tool: app,
              platform: 'darwin'
            });
          }
          const candidates = {
            notepad: ['gedit', 'kate', 'xed', 'mousepad', 'nano'],
            calc: ['gnome-calculator', 'qalculate-gtk', 'galculator', 'xcalc'],
            taskmgr: ['gnome-system-monitor', 'plasma-systemmonitor', 'ksysguard', 'btop', 'htop']
          }[tool];
          for (const bin of candidates) {
            try {
              await exec(`command -v ${bin}`, { shell: true, timeout: 4000 });
            } catch {
              continue;
            }
            try {
              await new Promise((resolve, reject) => {
                const child = spawn(bin, [], { detached: true, stdio: 'ignore' });
                child.once('error', reject);
                child.once('spawn', () => {
                  child.unref();
                  resolve();
                });
              });
              return this.successResponse({
                message: `已启动 ${bin}`,
                tool: bin,
                platform: 'linux'
              });
            } catch {
              /* try next candidate */
            }
          }
          return this.errorResponse(
            'OPEN_SYSTEM_TOOL_FAILED',
            `未找到可用程序，请安装 ${candidates.join(' / ')} 之一`
          );
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 打开系统工具失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_SYSTEM_TOOL_FAILED', err.message);
        }
      },
      enabled: true
    });
    this.registerMCPTool('screenshot', {
      description:
        '截取宿主 OS 全屏桌面 PNG（保存到 data/trash/screenshot/）。Playwright 浏览器页面截图必须用 browser.browser_screenshot，勿用本工具。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          const screenshot = (await import('screenshot-desktop')).default;

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const screenshotDir = path.join(paths.trash, 'screenshot');

          const filename = `screenshot_${timestamp}.png`;
          const screenshotPath = path.join(screenshotDir, filename);

          const img = await screenshot({ screen: -1 });
          await fs.writeFile(screenshotPath, img);

          const stats = await fs.stat(screenshotPath);
          if (stats.size === 0) {
            throw new Error('截屏文件为空');
          }

          // 记录到当前工作流上下文，方便后续继续使用
          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.screenshotPath = screenshotPath;
            context.stream.context.screenshotSize = stats.size;
          }

          // 如果是从 QQ 事件触发的，并且有 e，可直接把图片发回去
          const e = context.e;
          if (e && typeof e.reply === 'function') {
            try {
              const seg = segment;
              await e.reply([seg.image(screenshotPath)]);
            } catch (err) {
              RuntimeUtil.makeLog(
                'warn',
                `[desktop.screenshot] 截图发送到会话失败: ${err.message}`,
                'DesktopStream'
              );
            }
          }

          RuntimeUtil.makeLog('info', `截图成功: ${screenshotPath} (${stats.size} bytes)`, 'DesktopStream');
          
          return this.successResponse({
            filePath: screenshotPath,
            fileName: filename,
            size: stats.size
          });
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 截屏失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('SCREENSHOT_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('lock_screen', {
      description: '锁定屏幕：Windows LockWorkStation；macOS Ctrl+Cmd+Q；Linux loginctl / gnome-screensaver / xdg-screensaver。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        try {
          if (IS_WINDOWS) {
            await execCommand('rundll32.exe user32.dll,LockWorkStation');
            return this.successResponse({ message: '屏幕已锁定', platform: 'win32' });
          }
          if (IS_DARWIN) {
            await exec(
              `osascript -e 'tell application "System Events" to keystroke "q" using {control down, command down}'`,
              { timeout: 8000 }
            );
            return this.successResponse({ message: '已发送锁屏快捷键', platform: 'darwin' });
          }
          const attempts = [
            'loginctl lock-session',
            'gnome-screensaver-command -l',
            'xdg-screensaver lock',
            'xlock -mode blank'
          ];
          let last = '';
          for (const cmd of attempts) {
            try {
              await exec(cmd, { shell: true, timeout: 8000 });
              return this.successResponse({ message: '已请求锁屏', command: cmd, platform: 'linux' });
            } catch (e) {
              last = e.message;
            }
          }
          return this.errorResponse('LOCK_SCREEN_FAILED', `锁屏失败：${last}`);
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 锁屏失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('LOCK_SCREEN_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('system_info', {
      description: '查看本机 CPU / 内存占用。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          // 使用systeminformation库获取系统信息（跨平台）
          const [cpu, mem] = await Promise.all([
            si.currentLoad(),
            si.mem()
          ]);

          const cpuUsage = cpu.currentLoad ? cpu.currentLoad.toFixed(1) : '0.0';
          const memTotal = mem.total / 1024 / 1024 / 1024;
          const memFree = mem.free / 1024 / 1024 / 1024;
          const memUsed = mem.used / 1024 / 1024 / 1024;
          const memUsedPercent = ((memUsed / memTotal) * 100).toFixed(1);

          const systemInfo = {
            cpu: `${cpuUsage}%`,
            memory: {
              usedPercent: `${memUsedPercent}%`,
              freeGB: `${memFree.toFixed(2)}GB`,
              totalGB: `${memTotal.toFixed(2)}GB`,
              usedGB: `${memUsed.toFixed(2)}GB`
            }
          };

          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.systemInfo = systemInfo;
          }

          return this.successResponse(systemInfo);
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 获取系统信息失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('SYSTEM_INFO_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('get_time', {
      description: '获取服务器当前本地时间与时区（无需再猜时间）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => {
        const now = new Date();
        return this.successResponse({
          iso: now.toISOString(),
          local: now.toLocaleString('zh-CN', { hour12: false }),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
          epochMs: now.getTime()
        });
      },
      enabled: true
    });

    this.registerMCPTool('open_browser', {
      description: '打开浏览器访问网页。在默认浏览器中打开指定的URL，支持跨平台。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '网页URL（必须包含协议，如 https://）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, _context = {}) => {
        const url = this.getParam(args, 'url');
        if (!url) {
          return this.errorResponse('INVALID_PARAM', 'URL不能为空');
        }

        const commands = {
          win32: `start "" "${url}"`,
          darwin: `open "${url}"`,
          linux: `xdg-open "${url}"`
        };

        try {
          const command = commands[process.platform] || commands.linux;
          await execCommand(command, { shell: IS_WINDOWS ? 'cmd.exe' : undefined });
          return this.successResponse({ message: `已打开浏览器访问: ${url}`, url });
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 打开浏览器失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_BROWSER_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('power_control', {
      description:
        '关机/重启/取消：Windows 使用 shutdown；Linux 使用 shutdown/systemctl；macOS 通过 AppleScript 调系统对话框（可能出现确认，且无法像 Windows 一样可靠取消已调度任务）。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'shutdown（约 60 秒后关机）、shutdown_now（立即关机）、restart（约 60 秒后重启）、cancel（取消；主要支持 Windows / systemd 登录会话）',
            enum: ['shutdown', 'shutdown_now', 'restart', 'cancel']
          }
        },
        required: ['action']
      },
      handler: async (args = {}, _context = {}) => {
        const { action } = args;
        if (!action) {
          return this.errorResponse('INVALID_PARAM', '操作类型不能为空');
        }

        try {
          if (IS_WINDOWS) {
            const commands = {
              shutdown: { cmd: 'shutdown /s /t 60', delay: 60 },
              shutdown_now: { cmd: 'shutdown /s /t 0', delay: 0 },
              restart: { cmd: 'shutdown /r /t 60', delay: 60 },
              cancel: { cmd: 'shutdown /a', delay: undefined }
            };
            const config = commands[action];
            if (!config) {
              return this.errorResponse('INVALID_PARAM', `不支持的操作类型: ${action}`);
            }
            await execCommand(config.cmd);
            return this.successResponse({
              message: action === 'cancel' ? '已取消关机/重启' : `已执行 ${action}`,
              action,
              delay: config.delay,
              platform: 'win32'
            });
          }

          if (IS_DARWIN) {
            if (action === 'cancel') {
              return this.errorResponse(
                'PLATFORM_LIMIT',
                'macOS 无法通过此工具取消已调度的关机/重启，请在系统界面中操作'
              );
            }
            if (action === 'shutdown_now' || action === 'shutdown') {
              await exec(`osascript -e 'tell application "System Events" to shut down'`, { timeout: 15000 });
            } else if (action === 'restart') {
              await exec(`osascript -e 'tell application "System Events" to restart'`, { timeout: 15000 });
            }
            return this.successResponse({
              message: '已向系统发送电源请求（可能出现确认对话框）',
              action,
              platform: 'darwin'
            });
          }

          if (action === 'cancel') {
            await exec('shutdown -c', { shell: true, timeout: 8000 });
            return this.successResponse({ message: '已取消关机/重启', action, platform: process.platform });
          }
          const linuxCmd =
            action === 'shutdown_now'
              ? 'shutdown -h now'
              : action === 'shutdown'
                ? 'shutdown -h +1'
                : 'shutdown -r +1';
          await exec(linuxCmd, { shell: true, timeout: 8000 });
          return this.successResponse({
            message: `已执行 ${linuxCmd}（部分发行版需 root 或 polkit 授权）`,
            action,
            platform: 'linux'
          });
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 电源控制失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('POWER_CONTROL_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('disk_space', {
      description: '查看各磁盘的使用情况',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, context = {}) => {
        try {
          // 使用systeminformation库获取磁盘空间（跨平台）
          const fsSize = await si.fsSize();
          const disks = [];

          for (const disk of fsSize) {
            const totalGB = disk.size / 1024 / 1024 / 1024; // GB
            const usedGB = disk.used / 1024 / 1024 / 1024; // GB
            const freeGB = (disk.size - disk.used) / 1024 / 1024 / 1024; // GB
            const usedPercent = ((disk.used / disk.size) * 100).toFixed(1);

            disks.push({
              mount: disk.mount,
              usedPercent: parseFloat(usedPercent),
              freeGB: parseFloat(freeGB.toFixed(2)),
              totalGB: parseFloat(totalGB.toFixed(2)),
              usedGB: parseFloat(usedGB.toFixed(2)),
              display: `${disk.mount} ${usedPercent}% 已用 (${freeGB.toFixed(2)}GB / ${totalGB.toFixed(2)}GB 可用)`
            });
          }

          if (context.stream) {
            context.stream.context = context.stream.context || {};
            context.stream.context.diskSpace = disks.length > 0 ? disks.map(d => d.display) : null;
          }

          return this.successResponse({
            disks,
            count: disks.length
          });
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 获取磁盘空间失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('DISK_SPACE_FAILED', err.message);
        }
      },
      enabled: true
    });


    this.registerMCPTool('open_application', {
      description:
        '打开应用程序或路径：Windows 支持桌面 .lnk 与 start；macOS 用 open -a 或打开路径；Linux 打开路径或 /bin/sh -lc 启动命令。',
      inputSchema: {
        type: 'object',
        properties: {
          appName: {
            type: 'string',
            description: '要打开的应用程序名称或路径'
          }
        },
        required: ['appName']
      },
      handler: async (args = {}, _context = {}) => {
        const { appName } = args;
        if (!appName) {
          return this.errorResponse('INVALID_PARAM', '应用程序名称不能为空');
        }

        const workspace = this.getWorkspace();

        try {
          if (IS_WINDOWS) {
            const files = await fs.readdir(workspace);
            let shortcutPath = null;
            for (const file of files) {
              if (file.endsWith('.lnk') && file.toLowerCase().includes(appName.toLowerCase())) {
                shortcutPath = path.join(workspace, file);
                break;
              }
            }
            if (shortcutPath) {
              const escaped = shortcutPath.replace(/"/g, '""');
              await exec(`start "" "${escaped}"`, { shell: 'cmd.exe' });
              return this.successResponse({
                message: `已打开快捷方式: ${appName}`,
                appName,
                shortcutPath
              });
            }
            try {
              const child = spawn(appName, [], { detached: true, stdio: 'ignore', shell: true });
              child.unref();
            } catch {
              await exec(`start "" "${String(appName).replace(/"/g, '""')}"`, { shell: 'cmd.exe' });
            }
            return this.successResponse({ message: `已尝试打开: ${appName}`, appName });
          }

          if (IS_DARWIN) {
            try {
              await exec(`open -a "${String(appName).replace(/"/g, '\\"')}"`, { timeout: 20000 });
              return this.successResponse({ message: `已打开应用: ${appName}`, appName, platform: 'darwin' });
            } catch {
              try {
                const p = path.isAbsolute(appName) ? appName : path.join(workspace, appName);
                await fs.access(p);
                await this.openPathDetached(p);
                return this.successResponse({ message: `已打开路径: ${p}`, appName, path: p, platform: 'darwin' });
              } catch (e2) {
                return this.errorResponse('OPEN_APPLICATION_FAILED', e2.message);
              }
            }
          }

          const p = path.isAbsolute(appName) ? appName : path.join(workspace, appName);
          try {
            await fs.access(p);
            await this.openPathDetached(p);
            return this.successResponse({ message: `已打开路径: ${p}`, appName, platform: 'linux' });
          } catch {
            try {
              await new Promise((resolve, reject) => {
                const child = spawn('/bin/sh', ['-lc', appName], { detached: true, stdio: 'ignore' });
                child.once('error', reject);
                child.once('spawn', () => {
                  child.unref();
                  resolve();
                });
              });
              return this.successResponse({ message: `已尝试启动: ${appName}`, appName, platform: 'linux' });
            } catch (e3) {
              return this.errorResponse('OPEN_APPLICATION_FAILED', e3.message);
            }
          }
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 打开应用程序失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('OPEN_APPLICATION_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('cleanup_processes', {
      description:
        '结束登记在 BaseTools.processRegistry 中的子进程：Windows 使用 taskkill，macOS/Linux 使用 SIGTERM。',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      },
      handler: async (_args = {}, _context = {}) => {
        try {
          const result = await this.tools.cleanupProcesses();
          return this.successResponse({ 
            message: '进程清理完成',
            killed: result.killed || [],
            count: (result.killed || []).length
          });
        } catch (err) {
          RuntimeUtil.makeLog('error', `[desktop] 清理进程失败: ${err.message}`, 'DesktopStream');
          return this.errorResponse('CLEANUP_PROCESSES_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerDesktopExtensionTools();
  }

  /** 剪贴板与 open_path（无 YAML 开关，与工作区解析一致） */
  registerDesktopExtensionTools() {
    this.registerMCPTool('read_clipboard', {
      description:
        '读取系统剪贴板文本：Windows PowerShell Get-Clipboard；macOS pbpaste；Linux 优先 xclip 再 xsel（Wayland 需对应工具）。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async (_args = {}, _context = {}) => {
        try {
          const text = await this._readClipboardText();
          return this.successResponse({
            text,
            length: text.length,
            platform: process.platform
          });
        } catch (err) {
          return this.errorResponse('CLIPBOARD_READ_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('write_clipboard', {
      description: '将纯文本写入系统剪贴板（覆盖当前剪贴板内容），跨平台。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要写入的文本' }
        },
        required: ['text']
      },
      handler: async (args = {}, _context = {}) => {
        const text = this.getParam(args, 'text', 'content');
        if (text === undefined || text === null) {
          return this.errorResponse('INVALID_PARAM', 'text 不能为空');
        }
        const s = String(text);
        if (s.length > 2_000_000) {
          return this.errorResponse('INVALID_PARAM', '文本过长（>2MB）');
        }
        try {
          await this._writeClipboardText(s);
          return this.successResponse({ message: '已写入剪贴板', length: s.length });
        } catch (err) {
          return this.errorResponse('CLIPBOARD_WRITE_FAILED', err.message);
        }
      },
      enabled: true
    });

    this.registerMCPTool('open_path', {
      description:
        '用系统默认应用打开文件或目录。相对路径相对于当前 Agent 工作区（data/ai-workspace）；支持绝对路径。',
      inputSchema: {
        type: 'object',
        properties: {
          targetPath: {
            type: 'string',
            description: '文件或目录路径'
          }
        },
        required: ['targetPath']
      },
      handler: async (args = {}, _context = {}) => {
        const raw = this.getParam(args, 'targetPath', 'path', 'filePath');
        if (!raw || typeof raw !== 'string') {
          return this.errorResponse('INVALID_PARAM', 'targetPath 不能为空');
        }
        const resolved = path.isAbsolute(raw.trim())
          ? path.normalize(raw.trim())
          : path.join(this.getWorkspace(), raw.trim());
        try {
          await fs.access(resolved);
        } catch {
          return this.errorResponse('NOT_FOUND', `路径不存在: ${resolved}`);
        }
        try {
          await this.openPathDetached(resolved);
          return this.successResponse({ message: '已请求打开', path: resolved });
        } catch (err) {
          return this.errorResponse('OPEN_PATH_FAILED', err.message);
        }
      },
      enabled: true
    });
  }

  async _readClipboardText() {
    if (process.platform === 'win32') {
      const out = await execCommand('powershell -NoProfile -Command "Get-Clipboard -Raw"', {
        shell: 'cmd.exe',
        timeout: 8000
      });
      return (out ?? '').replace(/\r\n/g, '\n');
    }
    if (process.platform === 'darwin') {
      const out = await execCommand('pbpaste', { timeout: 8000 });
      return out ?? '';
    }
    try {
      const out = await execCommand('xclip -selection clipboard -o', { timeout: 8000 });
      return out ?? '';
    } catch {
      const out = await execCommand('xsel --clipboard --output', { timeout: 8000 });
      return out ?? '';
    }
  }

  async _writeClipboardText(text) {
    if (process.platform === 'win32') {
      const b64 = Buffer.from(text, 'utf8').toBase64();
      await execCommand(
        `powershell -NoProfile -Command "$b='${b64}'; $t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b)); Set-Clipboard -Value $t"`,
        { shell: 'cmd.exe', timeout: 15000, maxBuffer: 20 * 1024 * 1024 }
      );
      return;
    }
    if (process.platform === 'darwin') {
      await new Promise((resolve, reject) => {
        const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exit ${code}`))));
        child.stdin.write(text, 'utf8');
        child.stdin.end();
      });
      return;
    }
    const pipeToClipboard = (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let err = '';
        child.stderr?.on('data', (c) => {
          err += c.toString();
        });
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exit ${code}`))
        );
        child.stdin.write(text, 'utf8');
        child.stdin.end();
      });
    try {
      await pipeToClipboard('xclip', ['-selection', 'clipboard']);
    } catch {
      await pipeToClipboard('xsel', ['--clipboard', '--input']);
    }
  }

  buildSystemPrompt(context) {
    const { question, e } = context;
    const persona =
      (question && (question.persona || question.PERSONA)) ||
      '你是一个智能桌面助手，帮助用户完成文件操作、系统管理等任务。';
    const now = new Date().toLocaleString('zh-CN');
    const isMaster = e?.isMaster === true;
    const workspace = this.getWorkspace();

    const fileContent = context.fileContent;
    const fileSearchResult = context.fileSearchResult;
    const commandOutput = context.commandOutput;

    const fileContext = this.buildFileContext(fileSearchResult, fileContent, commandOutput, context);

    return `【人设】
${persona}
【工作区】
工作区：${workspace}
- 文件操作默认在此目录进行

【工具说明】
所有能力经 MCP（本流）：
- 系统：show_desktop, open_system_tool, lock_screen, power_control, get_time
- 打开：open_application, open_browser, open_path（已移除 create_folder/open_explorer，建目录用 tools.run，开资源管理器用 open_path）
- 信息：screenshot, system_info, disk_space；列文件用 tools.list_files
- 剪贴板：read_clipboard / write_clipboard
- 进程：cleanup_processes；命令执行用 tools.run
- 检索：web.web_search

${fileContext ? `【上下文】\n${fileContext}\n` : ''}
【时间】
${now}
${isMaster ? '【权限】\n你拥有主人权限，可以执行所有系统操作。\n\n' : ''}【规则】
1. 执行功能时必须回复文本内容，不要只执行不回复
2. 优先使用MCP工具执行操作
3. 文件操作默认在工作区进行
4. 如果找到文件内容，请在回复中直接告知用户内容
`;
  }

  async buildChatContext(e, question) {
    const messages = [];

    messages.push({
      role: 'system',
      content: await this.finalizeSystemPromptContent(this.buildSystemPrompt({ e, question }))
    });

    const text = typeof question === 'string'
      ? question
      : (question?.content ?? question?.text ?? '');

    // 从事件中提取图片（标准层：OneBot / device / 任意 image|mface 段）
    const extracted = extractVisionFromSegments(e?.message, { skipStickers: true });
    const images = extracted.images.map((x) => visionRefToLocator(x)).filter(Boolean);
    const replyImages = extracted.replyImages.map((x) => visionRefToLocator(x)).filter(Boolean);

    const userName =
      question?.userName ||
      question?.username ||
      e?.sender?.card ||
      e?.sender?.nickname ||
      '用户';

    const userId = question?.userId || e?.user_id || '';
    const prefix = userId ? `${userName}(${userId}): ` : `${userName}: `;

    if (this.embeddingConfig?.enabled && text) {
      const key =
        question?.conversationId ||
        e?.group_id ||
        `session_${userId || 'anonymous'}`;

      this.storeMessageMemory(key, {
        user_id: userId,
        nickname: userName,
        message: text,
        message_id: Date.now().toString(),
        time: Date.now()
      }).catch(() => { });
    }

    messages.push({
      role: 'user',
      content: buildAgtUserContent({
        text: `${prefix}${text}`,
        images,
        replyImages
      })
    });

    return messages;
  }

  /**
   * 构建文件上下文提示
   */
  buildFileContext(fileSearchResult, fileContent, commandOutput, context) {
    const sections = [];

    const fileSection = this.buildFileSection(fileSearchResult, fileContent, context);
    if (fileSection) sections.push(fileSection);

    const commandSection = this.buildCommandSection(commandOutput, context);
    if (commandSection) sections.push(commandSection);

    return sections.join('\n\n');
  }

  /**
   * 构建文件部分
   */
  buildFileSection(fileSearchResult, fileContent, context) {
    if (fileSearchResult?.found && fileContent) {
      const fileName = fileSearchResult.fileName || '文件';
      const filePath = fileSearchResult.path || '';
      const content = fileContent.slice(0, 2000);
      const truncated = fileContent.length > 2000 ? '\n...(内容已截断)' : '';
      return `【已找到文件内容】\n文件名：${fileName}\n${filePath ? `文件路径：${filePath}\n` : ''}文件内容如下：\n${content}${truncated}\n\n请在回复中直接告知用户上述文件内容，或使用此内容完成后续任务（如生成Excel）。`;
    }

    if (fileSearchResult?.found === false) {
      return `【文件查找结果】\n未找到文件：${context.fileError || '文件不存在'}`;
    }

    return '';
  }

  /**
   * 构建命令部分
   */
  buildCommandSection(commandOutput, context) {
    if (!commandOutput || !context.commandSuccess) return '';

    const output = commandOutput.slice(0, 1000);
    const truncated = commandOutput.length > 1000 ? '\n...(输出已截断)' : '';
    return `【上一个命令的输出结果】\n${output}${truncated}\n\n可以使用此输出结果来完成当前任务。`;
  }

  async cleanup() {
    if (this.tools) {
      await this.tools.cleanupProcesses();
    }

    await super.cleanup();
  }
}
