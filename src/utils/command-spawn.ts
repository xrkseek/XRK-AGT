import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const IS_WINDOWS = process.platform === 'win32';

export type SpawnSpec = { command: string; args: string[]; shell: boolean };

function exists(filePath: string | null | undefined): boolean {
  return !!(filePath && fsSync.existsSync(filePath));
}

function findOnPath(name: string): string | null {
  const lookup = IS_WINDOWS ? 'where.exe' : 'which';
  const result = spawnSync(lookup, [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout?.trim()) return null;
  const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (!IS_WINDOWS) return lines[0]!;

  // where 常先给出无扩展名 shim（如 ...\npx），裸 spawn 会 ENOENT；优先 .cmd/.bat/.exe
  const withExt = lines.find((line) => /\.(cmd|bat|exe)$/i.test(line));
  if (withExt) return withExt;
  for (const line of lines) {
    if (exists(`${line}.cmd`)) return `${line}.cmd`;
    if (exists(`${line}.exe`)) return `${line}.exe`;
    if (exists(`${line}.bat`)) return `${line}.bat`;
  }
  return lines[0]!;
}

function spawnViaNode(scriptPath: string, args: string[], nodeExe: string = process.execPath): SpawnSpec {
  return { command: nodeExe, args: [scriptPath, ...args], shell: false };
}

/**
 * 跑 Windows .cmd/.bat。
 * `C:\Program Files\...` 必须给 command 本身加引号，否则 shell 会拆成 `C:\Program`。
 */
function spawnWindowsCmd(cmdPath: string, args: string[]): SpawnSpec {
  const command = /[\s]/.test(cmdPath) ? `"${cmdPath.replace(/"/g, '')}"` : cmdPath;
  return { command, args: args.map((a) => String(a)), shell: true };
}

/**
 * npm / npx：优先 `node.exe` + `*-cli.js`（避免 .cmd + Program Files 空格问题）。
 */
function resolveNpmFamilySpawn(kind: 'npm' | 'npx', args: string[]): SpawnSpec | null {
  const cliName = kind === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  const roots = new Set<string>();

  const addRoot = (dir: string | null | undefined) => {
    if (dir && exists(dir)) roots.add(dir);
  };

  addRoot(path.dirname(process.execPath));
  const onPath = findOnPath(kind);
  if (onPath) addRoot(path.dirname(onPath));
  if (IS_WINDOWS) {
    addRoot(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
    const pf86 = process.env['ProgramFiles(x86)'];
    if (pf86) addRoot(path.join(pf86, 'nodejs'));
  }

  for (const root of roots) {
    const cli = path.join(root, 'node_modules', 'npm', 'bin', cliName);
    if (!exists(cli)) continue;
    const nodeExe = path.join(root, IS_WINDOWS ? 'node.exe' : 'node');
    if (exists(nodeExe)) return spawnViaNode(cli, args, nodeExe);
    return spawnViaNode(cli, args);
  }
  return null;
}

function pnpmCjsCandidates(cwd: string): string[] {
  const candidates = [path.join(cwd, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')];
  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
  }
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  candidates.push(path.join(programFiles, 'nodejs', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
  return [...new Set(candidates)].filter((candidate) => exists(candidate));
}

function toPnpmSpawn(executable: string, args: string[], cwd: string = process.cwd()): SpawnSpec {
  if (executable.endsWith('.cjs')) {
    return spawnViaNode(executable, args);
  }
  if (IS_WINDOWS) {
    if (executable.endsWith('.exe')) {
      return { command: executable, args, shell: false };
    }
    const cjsNearShim = path.join(path.dirname(executable), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (exists(cjsNearShim)) {
      return spawnViaNode(cjsNearShim, args);
    }
    const cjs = pnpmCjsCandidates(cwd)[0];
    if (cjs) return spawnViaNode(cjs, args);

    const cmdPath = /\.(cmd|bat)$/i.test(executable) ? executable : `${executable}.cmd`;
    if (exists(cmdPath)) return spawnWindowsCmd(cmdPath, args);
  }
  return { command: executable, args, shell: false };
}

function localPnpmBin(cwd: string): string | null {
  const bin = path.join(cwd, 'node_modules', '.bin', IS_WINDOWS ? 'pnpm.cmd' : 'pnpm');
  return exists(bin) ? bin : null;
}

function nodeCorepackPath(): string | null {
  const corepack = path.join(path.dirname(process.execPath), IS_WINDOWS ? 'corepack.cmd' : 'corepack');
  return exists(corepack) ? corepack : null;
}

function resolveNpmExecPnpm(args: string[]): SpawnSpec | null {
  const viaCli = resolveNpmFamilySpawn('npm', ['exec', '--yes', 'pnpm', ...args]);
  if (viaCli) return viaCli;
  if (IS_WINDOWS) {
    const npmCmd = path.join(path.dirname(process.execPath), 'npm.cmd');
    if (exists(npmCmd)) return spawnWindowsCmd(npmCmd, ['exec', '--yes', 'pnpm', ...args]);
  }
  const npm = findOnPath('npm');
  if (npm) {
    return (
      resolveWindowsExecutable(npm, ['exec', '--yes', 'pnpm', ...args]) || {
        command: npm,
        args: ['exec', '--yes', 'pnpm', ...args],
        shell: false,
      }
    );
  }
  return null;
}

export function getPnpmInstallHint(): string {
  return 'corepack enable pnpm  或  npm install -g pnpm  后重新运行 node app';
}

export function resolvePnpmSpawn(args: string[], cwd: string = process.cwd()): SpawnSpec {
  const cjs = pnpmCjsCandidates(cwd)[0];
  if (cjs) return spawnViaNode(cjs, args);

  const local = localPnpmBin(cwd);
  if (local) return toPnpmSpawn(local, args, cwd);

  if (IS_WINDOWS) {
    const standalone = path.join(process.env.LOCALAPPDATA || '', 'pnpm', 'pnpm.exe');
    if (exists(standalone)) {
      return { command: standalone, args, shell: false };
    }
  }

  const onPath = findOnPath('pnpm');
  if (onPath) return toPnpmSpawn(onPath, args, cwd);

  const corepack = nodeCorepackPath();
  if (corepack) {
    return IS_WINDOWS
      ? spawnWindowsCmd(corepack, ['pnpm', ...args])
      : { command: corepack, args: ['pnpm', ...args], shell: false };
  }

  const npmExec = resolveNpmExecPnpm(args);
  if (npmExec) return npmExec;

  throw new Error(`pnpm 未安装或不在 PATH 中，请执行: ${getPnpmInstallHint()}`);
}

/**
 * Windows：把 PATH/绝对路径上的 npm/npx 等解析成可 spawn 的规格。
 */
function resolveWindowsExecutable(executable: string, args: string[]): SpawnSpec | null {
  if (!executable) return null;
  if (/\.(cmd|bat)$/i.test(executable)) return spawnWindowsCmd(executable, args);
  if (/\.exe$/i.test(executable)) return { command: executable, args, shell: false };
  if (exists(`${executable}.cmd`)) return spawnWindowsCmd(`${executable}.cmd`, args);
  if (exists(`${executable}.bat`)) return spawnWindowsCmd(`${executable}.bat`, args);
  if (exists(`${executable}.exe`)) return { command: `${executable}.exe`, args, shell: false };
  return null;
}

export function resolveCommandSpawn(
  command: string,
  args: string[],
  cwd: string = process.cwd(),
): SpawnSpec {
  if (command === 'pnpm') {
    return resolvePnpmSpawn(args, cwd);
  }

  const bare = String(command || '').trim().toLowerCase();
  if (bare === 'npx' || bare === 'npm') {
    const viaCli = resolveNpmFamilySpawn(bare, args);
    if (viaCli) return viaCli;
  }

  if (IS_WINDOWS) {
    if (/[\\/]/.test(command)) {
      return resolveWindowsExecutable(command, args) || { command, args, shell: false };
    }
    const onPath = findOnPath(command);
    if (onPath) {
      return resolveWindowsExecutable(onPath, args) || { command: onPath, args, shell: false };
    }
    const besideNode = path.join(path.dirname(process.execPath), `${command}.cmd`);
    if (exists(besideNode)) return spawnWindowsCmd(besideNode, args);
    return { command, args, shell: true };
  }
  return { command, args, shell: false };
}

export function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string | undefined> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawnSpec: SpawnSpec;
    try {
      spawnSpec = resolveCommandSpawn(command, args, cwd);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      shell: spawnSpec.shell,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...baseEnv, ...extraEnv },
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EINVAL') {
        const hint = command === 'pnpm' ? `，请执行: ${getPnpmInstallHint()}` : '';
        reject(new Error(`${command} 未安装或不在 PATH 中${hint}`));
        return;
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGINT' || code === 130) {
        reject(new Error(`${command} 安装已中断（Ctrl+C），请重新运行 pnpm install`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code ?? 'unknown'}`));
    });
  });
}
