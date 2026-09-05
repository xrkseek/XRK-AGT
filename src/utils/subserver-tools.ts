/**
 * pyserver 业务 API ↔ Node 主服务 HTTP 桥接（插件/工作流用 AgentRuntime.callSubserver）
 *
 * 子服务运维命令请在子服务终端输入（与主服 > 分离，避免冲突）。
 */
import {
  formatSubserverCommandResult,
  parseSubserverCommandLine,
  subserverRuntimeUsageHint,
} from '#utils/subserver-runtimes.js';
import {
  formatSubserverError,
  getSubserverConfig,
  getSubserverDefaultRuntime,
} from '#utils/subserver-client.js';

const PYSERVER = 'pyserver';
const DEFAULT_SUBSERVER_CMD_TIMEOUT = 120_000;

type AgentRuntimeLike = {
  callSubserver: (requestPath: string, options?: Record<string, unknown>) => Promise<unknown>;
};

function getAgentRuntime(): AgentRuntimeLike {
  return (globalThis as { AgentRuntime?: AgentRuntimeLike }).AgentRuntime!;
}

/**
 * 代码内转发到子服务 POST /api/system/command（非终端入口）
 */
export async function dispatchSubserverCommand(
  rawLine: unknown,
  options: { timeout?: number; defaultRuntime?: string } = {},
): Promise<{
  ok: boolean;
  text: string;
  runtime: string;
  result?: unknown;
}> {
  const timeout = options.timeout ?? DEFAULT_SUBSERVER_CMD_TIMEOUT;
  const line = String(rawLine ?? '').trim();
  if (!line) {
    return {
      ok: true,
      text: subserverRuntimeUsageHint(),
      runtime: options.defaultRuntime || getSubserverDefaultRuntime(),
    };
  }

  const { runtime, commandLine } = parseSubserverCommandLine(
    line,
    options.defaultRuntime || getSubserverDefaultRuntime(),
  );

  try {
    const result = await getAgentRuntime().callSubserver('/api/system/command', {
      method: 'POST',
      body: { line: commandLine },
      timeout,
      runtime,
    });
    const prefix = runtime === 'pyserver' ? '' : `[${runtime}] `;
    return {
      ok: true,
      text: prefix + formatSubserverCommandResult(result),
      runtime,
      result,
    };
  } catch (err) {
    const hint = formatSubserverError(err, getSubserverConfig(runtime));
    return {
      ok: false,
      text: `子服务 ${runtime} 调用失败:\n${hint}`,
      runtime,
    };
  }
}

export async function callPyserver(
  requestPath: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return getAgentRuntime().callSubserver(requestPath, { runtime: PYSERVER, ...options });
}

export const PyserverApi = {
  mediaTools: {
    resize(filePath: string, width: number, height = 0, options: Record<string, unknown> = {}) {
      return callPyserver('/api/media-tools/resize', {
        method: 'POST',
        body: { path: filePath, width, height },
        ...options,
      });
    },
    convert(filePath: string, format: string, options: Record<string, unknown> = {}) {
      return callPyserver('/api/media-tools/convert', {
        method: 'POST',
        body: { path: filePath, format },
        ...options,
      });
    },
    thumbnail(filePath: string, size: number, options: Record<string, unknown> = {}) {
      return callPyserver('/api/media-tools/thumbnail', {
        method: 'POST',
        body: { path: filePath, size },
        ...options,
      });
    },
  },
  docPipeline: {
    extract(body: unknown, options: Record<string, unknown> = {}) {
      return callPyserver('/api/doc-pipeline/extract', { method: 'POST', body, ...options });
    },
    markdown(body: unknown, options: Record<string, unknown> = {}) {
      return callPyserver('/api/doc-pipeline/markdown', { method: 'POST', body, ...options });
    },
  },
  webFetch: {
    fetch(url: string, options: Record<string, unknown> = {}) {
      return callPyserver('/api/web-fetch/fetch', { method: 'POST', body: { url }, ...options });
    },
    cache(url: string, options: Record<string, unknown> = {}) {
      return callPyserver('/api/web-fetch/cache', { method: 'GET', query: { url }, ...options });
    },
  },
  groupCommand(
    group: string,
    cmd: string,
    args: unknown[] = [],
    options: Record<string, unknown> = {},
  ) {
    return callPyserver(`/api/${group}/command`, {
      method: 'POST',
      body: { cmd, args },
      ...options,
    });
  },
  systemCommand(line: string, options: Record<string, unknown> = {}) {
    return dispatchSubserverCommand(line, {
      ...options,
      defaultRuntime: PYSERVER,
    }).then(({ ok, text, result }) => {
      if (!ok) throw new Error(text);
      return result;
    });
  },
};
