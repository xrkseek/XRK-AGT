import RuntimeUtil from '#utils/runtime-util.js';
import { exec } from '#utils/exec-async.js';
import { normalizeError } from '#utils/normalize-error.js';

/**
 * 执行 shell 命令并归一化 stdout/stderr（Redis 本地启动等场景共用）
 */
export async function execCommandResult(
  cmd: string,
): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd);
    return {
      error: null,
      stdout: (stdout || '').toString(),
      stderr: (stderr || '').toString(),
    };
  } catch (err) {
    const error = normalizeError(err);
    const e = err as { stdout?: unknown; stderr?: unknown };
    return {
      error,
      stdout: (e.stdout || '').toString?.() ?? String(e.stdout || ''),
      stderr: (e.stderr || '').toString?.() ?? String(e.stderr || ''),
    };
  }
}

/**
 * 掩码连接 URL 中的密码
 */
export function maskConnectionUrl(url: string | null | undefined): string | null | undefined {
  return url ? url.replace(/:([^@:]+)@/, ':******@') : url;
}

/**
 * 检测当前系统是否为 ARM64（非 Windows）
 */
export async function detectArm64(): Promise<boolean> {
  if (process.platform === 'win32') return false;

  try {
    const { stdout } = await execCommandResult('uname -m');
    const archType = stdout.trim();
    return archType.includes('aarch64') || archType.includes('arm64');
  } catch {
    return false;
  }
}

/**
 * 数据库连接最终失败：记录 devHint 后 exit(1)
 */
export function finalizeDbConnectionFailure(
  label: string,
  error: unknown,
  options: { devHint?: string } = {},
): never {
  const normalized = normalizeError(error);
  RuntimeUtil.makeLog('error', `连接失败: ${normalized.message}`, label);
  RuntimeUtil.makeLog(
    'error',
    '请检查: 1)服务是否启动 2)配置是否正确 3)端口是否可用 4)网络是否正常',
    label,
  );

  if (process.env.NODE_ENV !== 'production' && options.devHint) {
    RuntimeUtil.makeLog('error', options.devHint, label);
  }

  process.exit(1);
}

type Connectable = { connect: () => Promise<void> };

/**
 * 带重试的数据库 connect 循环（Redis）
 */
export async function connectWithRetry<T extends Connectable>({
  label,
  maxRetries,
  fastStart,
  connectionUrl,
  createClient,
  onBeforeRetry,
  devHint,
}: {
  label: string;
  maxRetries: number;
  fastStart: boolean;
  connectionUrl: string;
  createClient: () => T;
  onBeforeRetry?: (retryCount: number) => Promise<void>;
  devHint?: string;
}): Promise<T> {
  let client = createClient();
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      RuntimeUtil.makeLog(
        'info',
        `连接中 [${retryCount + 1}/${maxRetries}]: ${maskConnectionUrl(connectionUrl)}`,
        label,
      );
      await client.connect();
      RuntimeUtil.makeLog('success', '连接成功', label);
      return client;
    } catch (err) {
      retryCount++;
      const error = normalizeError(err);
      RuntimeUtil.makeLog('warn', `连接失败 [${retryCount}/${maxRetries}]: ${error.message}`, label);

      if (retryCount < maxRetries) {
        if (!fastStart && onBeforeRetry) await onBeforeRetry(retryCount);
        client = createClient();
      } else {
        finalizeDbConnectionFailure(label, error, { devHint });
      }
    }
  }

  return client;
}
