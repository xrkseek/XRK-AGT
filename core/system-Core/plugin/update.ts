// @ts-nocheck
/**
 * 更新 — 对齐 Yunzai/TRSS「全部更新」习惯：
 * - #强制更新[ Core]：fetch --all → reset --hard @{upstream} → pull --ff-only
 * - #全部(强制)更新：先 fetch + 普通 pull；仅冲突时再强制（已最新不强制）
 * - 静默 / 定时：跳过「开始」「已是最新」；有更新或失败才说话（群/主人）
 */
import fs from 'node:fs';
import path from 'node:path';
import lodash from 'lodash';
import common from '#utils/common.js';
import { exec } from '#utils/exec-async.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { EXIT_RESTART } from '#utils/process-signals.js';
import { Restart } from './restart.js';

const GIT_TIMEOUT_MS = 600_000;
const DEFAULT_CRON = '0 0 12 * * *';
const CONFLICT_RE =
  /be overwritten by merge|CONFLICT|Would be overwritten|unmerged|needs merge/i;

let uping = false;

/** @typedef {'hard'|'onConflict'|'none'} ForceMode */

function autoUpdateCfg() {
  return runtimeConfig.agt?.autoUpdate || {};
}

function cronList(cfg) {
  const raw = cfg.cron;
  const list = Array.isArray(raw)
    ? raw
    : raw != null && String(raw).trim()
      ? [raw]
      : [DEFAULT_CRON];
  return list.map((c) => String(c).trim()).filter(Boolean);
}

export class update extends PluginBase {
  constructor() {
    super({
      name: '更新',
      dsc: '#更新 #强制更新 #全部更新；静默/定时有变更才通知',
      event: 'message',
      priority: 4000,
      rule: [
        { reg: '^#(强制)?更新(?:\\s*(.*))?$', fnc: 'update' },
        {
          reg: '^#(静默)?全部(强制)?更新$',
          fnc: 'updateAll',
          permission: 'master',
        },
        { reg: '^#(更新|查看)日志(?:\\s*(.*))?$', fnc: 'updateLog' },
      ],
    });
  }

  /** 对齐 TRSS：静默消息不刷「开始 / 已是最新」 */
  get quiet() {
    return /^#静默全部(强制)?更新$/.test(this.e?.msg || '');
  }

  async init() {
    const cfg = autoUpdateCfg();
    if (cfg.enabled === false) {
      this.task = null;
      return;
    }

    const tasks = cronList(cfg).map((cron) => ({
      name: '定时更新',
      cron,
      fnc: () => this.scheduledUpdateAll(),
      log: false,
    }));
    this.task = tasks.length === 1 ? tasks[0] : tasks;
  }

  /** @returns {ForceMode} */
  _forceModeFromMsg(msg = '') {
    if (/^#强制更新/.test(msg)) return 'hard';
    if (/全部强制更新/.test(msg)) return 'onConflict';
    return 'none';
  }

  async _git(cmd, cwd) {
    try {
      const { stdout, stderr } = await exec(cmd, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        ok: true,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      };
    } catch (err) {
      return {
        ok: false,
        error: err,
        stdout: String(err?.stdout || ''),
        stderr: String(err?.stderr || ''),
        message: String(err?.message || err),
      };
    }
  }

  _isConflict(ret) {
    const blob = `${ret.message || ''}\n${ret.stdout || ''}\n${ret.stderr || ''}`;
    return CONFLICT_RE.test(blob);
  }

  async _resolveUpstreamRef(cwd) {
    const upstream = await this._git(
      'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
      cwd
    );
    if (upstream.ok) {
      const ref = lodash.trim(upstream.stdout);
      if (ref && ref !== '@{u}') return ref;
    }
    const head = await this._git('git rev-parse --abbrev-ref HEAD', cwd);
    const branch = head.ok ? lodash.trim(head.stdout) : '';
    if (branch && branch !== 'HEAD') return `origin/${branch}`;
    return 'origin/main';
  }

  async _fetchAll(cwd) {
    return this._git('git fetch --all --prune', cwd);
  }

  /** 强制：fetch → reset --hard @{upstream} → ff-only pull */
  async _hardSync(cwd) {
    const fetchRet = await this._fetchAll(cwd);
    if (!fetchRet.ok) return fetchRet;
    const upstream = await this._resolveUpstreamRef(cwd);
    const resetRet = await this._git(`git reset --hard ${upstream}`, cwd);
    if (!resetRet.ok) return resetRet;
    return this._git('git pull --ff-only', cwd);
  }

  /** 普通：先 fetch 再 pull */
  async _softPull(cwd) {
    const fetchRet = await this._fetchAll(cwd);
    if (!fetchRet.ok) return fetchRet;
    return this._git('git pull --no-rebase', cwd);
  }

  async update() {
    if (!this.e.isMaster) return false;
    if (uping) {
      await this.reply('已有命令更新中..请勿重复操作');
      return false;
    }
    if (/详细|详情|面板|面版/.test(this.e.msg)) return false;

    uping = true;
    let isUp = false;
    try {
      const targetName = this.e.msg.replace(/#(强制)?更新/, '').trim() || '';
      const forceMode = this._forceModeFromMsg(this.e.msg);

      if (targetName) {
        if (!this.isValidGitCore(targetName)) {
          await this.reply(
            `指定的 Core 目录 ${targetName} 不存在或不是有效的 git 仓库`
          );
          return false;
        }
        const result = await this.runUpdate(targetName, { forceMode });
        isUp = !!result.updated;
      } else {
        const result = await this.runUpdate('', { forceMode });
        isUp = !!result.updated;
      }
      this._scheduleRestartIfUpdated(isUp);
    } catch (error) {
      logger.error(`更新失败: ${error.message}`, error);
      await this.reply(`更新失败: ${error.message}`);
      return false;
    } finally {
      uping = false;
    }
    return true;
  }

  /**
   * @param {string} coreName
   * @param {{ forceMode?: ForceMode, muteStart?: boolean, quiet?: boolean }} [opts]
   * @returns {Promise<{ updated: boolean, status: string, lines: string[] }>}
   */
  async runUpdate(coreName = '', opts = {}) {
    const forceMode =
      opts.forceMode ?? this._forceModeFromMsg(this.e?.msg || '');
    const isProjectUpdate = !coreName;
    const targetPath = isProjectUpdate ? '.' : path.join('core', coreName);
    const targetDisplayName = isProjectUpdate ? 'XRK-AGT 项目' : coreName;
    const lines = [];
    const reply = async (msg) => {
      lines.push(msg);
      if (this.reply) await this.reply(msg);
    };

    const oldCommitId = await this.getCommitId(targetPath);

    if (forceMode === 'hard') {
      if (!opts.muteStart) await reply(`开始强制更新 ${targetDisplayName}`);
      if (!opts.quiet)
        logger.mark(
          `${this.e?.logFnc || '[更新]'} 强制更新：${targetDisplayName}`
        );
      const ret = await this._hardSync(targetPath);
      return this._finishUpdate(ret, {
        targetPath,
        targetDisplayName,
        oldCommitId,
        lines,
        reply,
        forced: true,
        quiet: opts.quiet,
      });
    }

    if (!opts.muteStart) await reply(`开始更新 ${targetDisplayName}`);
    if (!opts.quiet)
      logger.mark(`${this.e?.logFnc || '[更新]'} 更新：${targetDisplayName}`);
    let ret = await this._softPull(targetPath);

    if (!ret.ok && forceMode === 'onConflict' && this._isConflict(ret)) {
      await reply(`${targetDisplayName} 拉取冲突，改为强制更新…`);
      if (!opts.quiet)
        logger.mark(
          `${this.e?.logFnc || '[更新]'} 冲突后强制：${targetDisplayName}`
        );
      ret = await this._hardSync(targetPath);
      return this._finishUpdate(ret, {
        targetPath,
        targetDisplayName,
        oldCommitId,
        lines,
        reply,
        forced: true,
        quiet: opts.quiet,
      });
    }

    if (!ret.ok) {
      await this.handleGitError(
        ret.error || new Error(ret.message),
        ret.stdout || ret.stderr
      );
      lines.push(`更新失败：${targetDisplayName}`);
      return { updated: false, status: 'failed', lines };
    }

    return this._finishUpdate(ret, {
      targetPath,
      targetDisplayName,
      oldCommitId,
      lines,
      reply,
      forced: false,
      quiet: opts.quiet,
    });
  }

  async _finishUpdate(ret, ctx) {
    const {
      targetPath,
      targetDisplayName,
      oldCommitId,
      lines,
      reply,
      forced,
      quiet,
    } = ctx;
    if (!ret.ok) {
      await this.handleGitError(
        ret.error || new Error(ret.message),
        ret.stdout || ret.stderr
      );
      lines.push(`更新失败：${targetDisplayName}`);
      return { updated: false, status: 'failed', lines };
    }

    const newCommitId = await this.getCommitId(targetPath);
    const time = await this.getTime(targetPath);
    if (oldCommitId === newCommitId) {
      if (!quiet)
        await reply(`${targetDisplayName} 已是最新\n最后更新时间：${time}`);
      else lines.push(`${targetDisplayName} 已是最新`);
      return { updated: false, status: 'latest', lines };
    }

    const tag = forced ? '强制更新成功' : '更新成功';
    await reply(`${targetDisplayName} ${tag}\n更新时间：${time}`);
    const updateLog = await this.getLog(
      targetPath,
      targetDisplayName,
      oldCommitId
    );
    if (updateLog) await reply(updateLog);
    if (!quiet)
      logger.mark(
        `${this.e?.logFnc || '[更新]'} ${tag}：${targetDisplayName} @ ${time}`
      );
    return { updated: true, status: forced ? 'forced' : 'updated', lines };
  }

  async getCommitId(cwd = '.') {
    const ret = await this._git('git rev-parse --short HEAD', cwd);
    return ret.ok ? lodash.trim(ret.stdout) : 'unknown';
  }

  async getTime(cwd = '.') {
    const ret = await this._git(
      'git log -1 --pretty=%cd --date=format:"%F %T"',
      cwd
    );
    return ret.ok ? lodash.trim(ret.stdout) || '获取时间失败' : '获取时间失败';
  }

  async handleGitError(err, stdout) {
    const msg = '更新失败！';
    const errMsg = err?.message || String(err);
    const stdoutStr = String(stdout || '');
    if (/Timed out|ETIMEDOUT|timeout/i.test(errMsg)) {
      await this.reply?.(
        `${msg}\n命令超时（>${Math.round(GIT_TIMEOUT_MS / 60000)} 分钟），请检查网络`
      );
      return;
    }
    if (
      /Failed to connect|unable to access|Could not read from remote/i.test(
        errMsg
      )
    ) {
      await this.reply?.(`${msg}\n连接失败：${this.extractRemoteUrl(errMsg)}`);
      return;
    }
    if (CONFLICT_RE.test(errMsg) || CONFLICT_RE.test(stdoutStr)) {
      await this.reply?.(
        `${msg}\n存在冲突，请解决后再更新；或对单仓执行 #强制更新 <Core名> / #强制更新（根仓）放弃本地修改`
      );
      return;
    }
    await this.reply?.(`${msg}\n${errMsg}${stdoutStr ? `\n${stdoutStr}` : ''}`);
  }

  extractRemoteUrl(str) {
    return (
      (str.match(/'([^']+)'/g) || []).pop()?.replace(/'/g, '') || '未知地址'
    );
  }

  isValidGitCore(coreName) {
    if (!coreName) return false;
    const corePath = path.join('core', coreName);
    return (
      fs.existsSync(corePath) &&
      fs.statSync(corePath).isDirectory() &&
      fs.existsSync(path.join(corePath, '.git'))
    );
  }

  /**
   * @param {{ forceMode?: ForceMode, silent?: boolean, fromSchedule?: boolean }} [opts]
   */
  async updateAll(opts = {}) {
    if (this.e && !this.e.isMaster) return false;
    if (uping) {
      await this.reply?.('已有命令更新中..请勿重复操作');
      return false;
    }

    const msg = this.e?.msg || '';
    const cfg = autoUpdateCfg();
    const isSilent =
      opts.silent === true || opts.fromSchedule === true || this.quiet;
    const forceMode =
      opts.forceMode ??
      (opts.fromSchedule
        ? cfg.forceOnConflict === false
          ? 'none'
          : 'onConflict'
        : this._forceModeFromMsg(msg));
    // 对齐 TRSS quiet：静默不刷开始/已是最新，有更新或失败才汇总出口
    const quiet = isSilent;

    const collected = [];
    const originalReply = this.reply?.bind(this);
    if (isSilent) {
      this.reply = async (message) => {
        collected.push(message);
      };
    } else if (forceMode === 'onConflict') {
      await this.reply?.('开始全部更新：已最新跳过强制，遇冲突再强制…');
    }

    uping = true;
    let isUp = false;
    const summary = { updated: [], latest: [], forced: [], failed: [] };

    try {
      const coreDir = path.join('.', 'core');
      if (fs.existsSync(coreDir)) {
        for (const subdir of fs.readdirSync(coreDir)) {
          if (!this.isValidGitCore(subdir)) continue;
          await common.sleep(quiet ? 400 : 800);
          const result = await this.runUpdate(subdir, {
            forceMode,
            muteStart: isSilent,
            quiet,
          });
          if (result.updated) isUp = true;
          if (result.status === 'updated') summary.updated.push(subdir);
          else if (result.status === 'latest') summary.latest.push(subdir);
          else if (result.status === 'failed') summary.failed.push(subdir);
          else if (result.status === 'forced') summary.forced.push(subdir);
        }
      }

      await common.sleep(quiet ? 400 : 800);
      const root = await this.runUpdate('', {
        forceMode,
        muteStart: isSilent,
        quiet,
      });
      if (root.updated) isUp = true;
      const rootLabel = 'XRK-AGT';
      if (root.status === 'updated') summary.updated.push(rootLabel);
      else if (root.status === 'latest') summary.latest.push(rootLabel);
      else if (root.status === 'failed') summary.failed.push(rootLabel);
      else if (root.status === 'forced') summary.forced.push(rootLabel);
    } catch (error) {
      logger.error(`全部更新失败: ${error.message}`, error);
      collected.push(`更新过程中出错: ${error.message}`);
      summary.failed.push('(过程异常)');
      if (!isSilent) await this.reply?.(`更新过程中出错: ${error.message}`);
    } finally {
      uping = false;
      if (isSilent && originalReply) this.reply = originalReply;
    }

    const hasNews = isUp || summary.failed.length > 0;
    const digest = this._formatSummary(summary, forceMode, {
      omitLatest: isSilent,
    });
    const pack = [
      digest,
      ...collected.filter((m) => typeof m !== 'string' || !/已是最新/.test(m)),
    ].filter(Boolean);

    if (opts.fromSchedule) {
      if (hasNews) await this.notifyMasters(pack, '定时更新汇总');
      this._scheduleRestartIfUpdated(isUp, true);
      return true;
    }

    if (isSilent) {
      // 群里/会话：有更新或失败才发汇总；全是最新不说话
      if (hasNews && originalReply && pack.length) {
        await originalReply(
          await common.makeForwardMsg(this.e, pack, '全部更新汇总')
        );
      }
    } else {
      await this.reply?.(digest);
    }

    this._scheduleRestartIfUpdated(isUp, false);
    return true;
  }

  _formatSummary(summary, forceMode, opts = {}) {
    const modeHint =
      forceMode === 'hard'
        ? '模式：硬强制'
        : forceMode === 'onConflict'
          ? '模式：冲突才强制'
          : '模式：普通拉取';
    const lines = [
      `【更新汇总】${modeHint}`,
      summary.updated.length ? `已更新：${summary.updated.join('、')}` : null,
      summary.forced.length ? `冲突后强制：${summary.forced.join('、')}` : null,
      !opts.omitLatest && summary.latest.length
        ? `已是最新：${summary.latest.length} 个`
        : null,
      summary.failed.length ? `失败：${summary.failed.join('、')}` : null,
    ].filter(Boolean);
    if (lines.length === 1) lines.push('无仓库变更');
    return lines.join('\n');
  }

  /** 定时入口：假 e + 静默全部（对齐 TRSS init 里的 #全部静更新） */
  async scheduledUpdateAll() {
    if (uping) return;
    this.e = {
      isMaster: true,
      msg: '#静默全部强制更新',
      logFnc: '[定时更新]',
      user_id: runtimeConfig.masterQQ?.[0],
    };
    try {
      await this.updateAll({ silent: true, fromSchedule: true });
    } catch (err) {
      logger.error(`[更新] 定时更新失败: ${err?.message || err}`, err);
    }
  }

  async notifyMasters(messages, title = '更新汇总') {
    const masters = (runtimeConfig.masterQQ || [])
      .map((q) => String(q))
      .filter(Boolean);
    const botIds = (
      Array.isArray(AgentRuntime.uin) ? [...AgentRuntime.uin] : []
    )
      .map(String)
      .filter((id) => id && id !== 'stdin');
    if (!masters.length || !botIds.length) return;

    const flat = messages.flatMap((m) => {
      if (m == null) return [];
      if (typeof m === 'string' || typeof m === 'number') return [String(m)];
      return [m];
    });
    if (!flat.length) return;

    for (const botId of botIds) {
      const bot = AgentRuntime[botId];
      if (!bot) continue;
      for (const qq of masters) {
        try {
          let payload = flat.join('\n\n');
          const friend = bot.pickFriend?.(qq) || bot.pickFriend?.(Number(qq));
          if (friend?.makeForwardMsg) {
            const nodes = [
              { message: title },
              ...flat.map((message) => ({ message })),
            ];
            payload = await friend.makeForwardMsg(nodes);
          } else {
            payload = `${title}\n\n${payload}`;
          }
          await AgentRuntime.sendFriendMsg(botId, qq, payload);
        } catch (err) {
          logger.error(
            `[更新] 推送主人失败 ${botId}/${qq}: ${err?.message || err}`
          );
        }
      }
    }
  }

  _scheduleRestartIfUpdated(didUpdate, fromSchedule = false) {
    if (!didUpdate) return;
    if (fromSchedule) {
      setTimeout(() => process.exit(EXIT_RESTART), 2000);
      return;
    }
    setTimeout(() => new Restart(this.e).restart(), 2000);
  }

  async getLog(cwd = '.', displayName = '', oldCommitId = null) {
    try {
      const ret = await this._git(
        'git log -100 --pretty="%h||[%cd] %s" --date=format:"%F %T"',
        cwd
      );
      if (!ret.ok || !ret.stdout) return false;

      const log = [];
      for (const str of ret.stdout.trim().split('\n')) {
        const parts = str.split('||');
        if (oldCommitId && parts[0] === oldCommitId) break;
        if (parts[1]?.includes('Merge branch')) continue;
        log.push(parts[1]);
      }
      if (!log.length) return '';

      let repoUrl = '';
      const cfg = await this._git('git config -l', cwd);
      if (cfg.ok) {
        repoUrl =
          cfg.stdout
            ?.match(/remote\..*\.url=.+/g)
            ?.map((url) =>
              url.replace(/remote\..*\.url=/, '').replace(/\/\/([^@]+)@/, '//')
            )
            .join('\n\n') || '';
      }

      if (this.e?.group || this.e?.friend) {
        return common.makeForwardMsg(
          this.e,
          [log.join('\n\n'), repoUrl].filter(Boolean),
          `${displayName} 更新日志，共${log.length}条`
        );
      }
      return `${displayName} 更新日志，共${log.length}条\n\n${log.join('\n')}${repoUrl ? `\n\n${repoUrl}` : ''}`;
    } catch (error) {
      logger.error('获取更新日志失败:', error);
      return `获取更新日志失败: ${error.message}`;
    }
  }

  async updateLog() {
    const targetName = this.e.msg.replace(/^#(更新|查看)日志/, '').trim() || '';
    if (targetName) {
      if (!this.isValidGitCore(targetName)) {
        await this.reply(
          `指定的 Core 目录 ${targetName} 不存在或不是有效的 git 仓库`
        );
        return false;
      }
      return this.reply(
        await this.getLog(path.join('core', targetName), targetName)
      );
    }
    return this.reply(await this.getLog('.', 'XRK-AGT 项目'));
  }
}
