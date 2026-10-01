import { exec as execCb, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promise 版 exec / execFile。
 * 至 Node 26.7 官方 API 仍无 node:child_process/promises 内置子模块，统一由此导出，待上游合入后可切换实现。
 */
export const exec = promisify(execCb);
export const execFile = promisify(execFileCb);
