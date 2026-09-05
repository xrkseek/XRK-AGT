/**
 * 多语言子服务 runtime 唯一目录（端口默认值；实际地址以 ai-workflow.yaml → subserver.runtimes 为准）
 */

export type SubserverRuntimeMeta = {
  label: string;
  port: number;
  language: string;
  path: string;
  start: string;
  data: string;
  aliases?: string[];
  framework?: string;
  examplePlugins?: string[];
};

export const SUBSERVER_RUNTIME_CATALOG: Record<string, SubserverRuntimeMeta> = {
  pyserver: {
    label: 'Python',
    port: 8000,
    language: 'python',
    path: 'subserver/pyserver',
    start: 'cd subserver/pyserver && uv run python main.py',
    data: 'data/subserver',
    aliases: ['py', 'python'],
  },
  goserver: {
    label: 'Go',
    port: 8001,
    language: 'go',
    path: 'subserver/goserver',
    start: 'cd subserver/goserver && go run .',
    data: 'data/goserver',
    aliases: ['go'],
  },
  phpserver: {
    label: 'PHP',
    port: 8002,
    language: 'php',
    path: 'subserver/phpserver',
    start: 'cd subserver/phpserver && php run.php',
    data: 'data/phpserver',
    aliases: ['php'],
  },
  jserver: {
    label: 'Java',
    port: 8003,
    language: 'java',
    framework: 'spring-boot',
    path: 'subserver/jserver',
    start: 'cd subserver/jserver && mvn -q spring-boot:run',
    data: 'data/jserver',
    aliases: ['java', 'j', 'spring'],
    examplePlugins: ['datetime-tools', 'json-tools'],
  },
  netserver: {
    label: '.NET',
    port: 8004,
    language: 'csharp',
    framework: 'aspnet-core',
    path: 'subserver/netserver',
    start: 'cd subserver/netserver && dotnet run',
    data: 'data/netserver',
    aliases: ['net', 'dotnet', 'csharp', 'cs'],
    examplePlugins: ['uuid-tools'],
  },
  rustserver: {
    label: 'Rust',
    port: 8005,
    language: 'rust',
    framework: 'axum',
    path: 'subserver/rustserver',
    start: 'node subserver/rustserver/run.mjs',
    data: 'data/rustserver',
    aliases: ['rust', 'rs'],
    examplePlugins: ['regex-tools'],
  },
};

const ALIAS_TO_RUNTIME = Object.fromEntries(
  Object.entries(SUBSERVER_RUNTIME_CATALOG).flatMap(([id, meta]) =>
    (meta.aliases || []).map((alias) => [alias.toLowerCase(), id]),
  ),
) as Record<string, string>;

/** data/<dir>/ 首段目录 → runtime id（pyserver 配置目录 subserver 不参与代理） */
const DATA_DIR_TO_RUNTIME = Object.fromEntries(
  Object.entries(SUBSERVER_RUNTIME_CATALOG).map(([id, meta]) => [
    meta.data.replace(/^data\//, ''),
    id,
  ]),
) as Record<string, string>;

/**
 * 解析 data/<dir>/… 路径（供文件代理与 runtime 路由共用）
 */
export function parseDataSubserverPath(
  relPath: string,
): { dir: string; runtime: string } | null {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('data/')) return null;
  const match = /^data\/([^/]+)\//.exec(normalized);
  if (!match) return null;
  const dir = match[1]!;
  if (dir === 'subserver') return null;
  return { dir, runtime: DATA_DIR_TO_RUNTIME[dir] || 'pyserver' };
}

export function listSubserverRuntimes(): string[] {
  return Object.keys(SUBSERVER_RUNTIME_CATALOG);
}

/**
 * @param token runtime id 或别名（可带 @ 前缀）
 */
export function resolveSubserverRuntime(token?: string | null): string | null {
  if (!token) return null;
  const raw = String(token).replace(/^@/, '').trim().toLowerCase();
  if (!raw) return null;
  if (SUBSERVER_RUNTIME_CATALOG[raw]) return raw;
  return ALIAS_TO_RUNTIME[raw] || null;
}

export function parseSubserverCommandLine(
  line: string,
  defaultRuntime = 'pyserver',
): { runtime: string; commandLine: string } {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { runtime: defaultRuntime, commandLine: 'help' };
  }
  const resolved = resolveSubserverRuntime(parts[0]);
  if (resolved) {
    return {
      runtime: resolved,
      commandLine: parts.slice(1).join(' ') || 'help',
    };
  }
  return { runtime: defaultRuntime, commandLine: parts.join(' ') };
}

/** @param payload 子服命令结果 */
export function formatSubserverCommandResult(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');
  const data = payload as Record<string, unknown>;
  if (data.ok === false) {
    const err = data.error || data.detail || '命令失败';
    const extra = data.available || data.commands;
    if (Array.isArray(extra) && extra.length) {
      return `${err}\n可用: ${extra.join(', ')}`;
    }
    return String(err);
  }
  if (Array.isArray(data.groups) && data.count != null) {
    return data.groups
      .map((g) => {
        const item = g as { group?: string; commands?: string[] };
        return `· ${item.group} [${(item.commands || []).join(', ')}]`;
      })
      .join('\n');
  }
  if (Array.isArray(data.groups)) {
    return `已注册: ${data.groups.join(', ')}`;
  }
  return JSON.stringify(payload, null, 2);
}

export function subserverRuntimeUsageHint(): string {
  return (
    '请在子服务终端操作（与主服 > 分离）:\n' +
    '  帮助 · 列表\n' +
    '  <组名> 状态 · <组名> 更新'
  );
}

/** Docker status / 健康探测用端点列表 */
export function subserverHealthEndpoints(
  serverPort: string = process.env.XRK_SERVER_PORT || '8080',
): Array<[string, string]> {
  return [
    ['主服', `http://127.0.0.1:${serverPort}/health`],
    ...Object.entries(SUBSERVER_RUNTIME_CATALOG).map(([id, meta]) => [
      meta.aliases?.[0] || id,
      `http://127.0.0.1:${meta.port}/health`,
    ] as [string, string]),
  ];
}
