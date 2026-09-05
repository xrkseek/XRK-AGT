// @ts-nocheck
/**
 * 危险命令模式（移植 goose security/patterns 高危子集，JS 版）。
 * 用于 tools.run / 任意工具参数串的静态扫描。
 */

/** @typedef {'low'|'medium'|'high'|'critical'} RiskLevel */

/**
 * @typedef {{ name: string, pattern: RegExp, description: string, risk: RiskLevel }} ThreatPattern
 */

/** @type {ThreatPattern[]} */
export const TOOL_THREAT_PATTERNS = [
  {
    name: 'rm_rf_root',
    pattern: /\brm\s+(-[rRfF]+\s+)*\/(?:\s|[;&|]|$)/,
    description: '递归删除根目录',
    risk: 'critical'
  },
  {
    name: 'rm_rf_home',
    pattern: /\brm\s+(-[rRfF]+\s+)*(~|\$HOME|\$\{HOME\}|\/home|\/root)(?:\/|\s|[;&|]|$)/,
    description: '递归删除 home/root',
    risk: 'critical'
  },
  {
    name: 'dd_disk',
    pattern: /\bdd\s+.*if=\/dev\/(zero|random|urandom).*of=\/dev\/[sh]d[a-z]/i,
    description: 'dd 覆写磁盘',
    risk: 'critical'
  },
  {
    name: 'curl_pipe_shell',
    pattern: /\b(curl|wget)\b[^|;]*\|\s*(bash|sh|zsh|powershell|pwsh)\b/i,
    description: '远程脚本管道进 shell',
    risk: 'critical'
  },
  {
    name: 'powershell_iex_download',
    pattern: /powershell[^;|]*DownloadString[^;|]*Invoke-Expression|IEX\s*\(\s*\(?New-Object/i,
    description: 'PowerShell 远程下载执行',
    risk: 'critical'
  },
  {
    name: 'reverse_shell',
    pattern: /\b(nc|ncat|netcat)\b[^;|]*\s-e\s*(bash|sh|cmd)|\/dev\/tcp\/|bash\s+-i\s+>&\s*\/dev\/tcp/i,
    description: '反弹 shell',
    risk: 'critical'
  },
  {
    name: 'sudoers_nopasswd',
    pattern: /NOPASSWD.*>.*sudoers|tee\s+.*sudoers/i,
    description: '写 sudoers 提权',
    risk: 'critical'
  },
  {
    name: 'format_drive',
    pattern: /\b(format|mkfs\.[a-z0-9]+)\s+[\\/]dev[\\/]/i,
    description: '格式化磁盘',
    risk: 'critical'
  },
  {
    name: 'ssh_key_exfil',
    pattern: /\b(curl|wget)\b[^;|]*\.(ssh)\/(id_rsa|id_ed25519|id_ecdsa)/i,
    description: '外传 SSH 私钥',
    risk: 'high'
  },
  {
    name: 'shadow_access',
    pattern: /\b(cat|type|Get-Content)\b[^;|]*([\\/]etc[\\/]shadow|\.password)/i,
    description: '读取 shadow/密码文件',
    risk: 'high'
  },
  {
    name: 'base64_pipe_shell',
    pattern: /\bbase64\s+(-d|--decode)\b[^|;]*\|\s*(bash|sh|zsh)\b/i,
    description: 'base64 解码后进 shell',
    risk: 'high'
  },
  {
    name: 'chmod_suid',
    pattern: /\bchmod\s+([ug]*\+s|[47][0-7]{3})\b/i,
    description: '设置 SUID',
    risk: 'high'
  },
  {
    name: 'docker_privileged',
    pattern: /\bdocker\s+(run|exec)\b[^;|]*--privileged\b/i,
    description: 'Docker 特权容器',
    risk: 'high'
  },
  {
    name: 'hosts_rewrite',
    pattern: /(>|>>)\s*[\\/]etc[\\/]hosts\b|tee\s+(-a\s+)?[\\/]etc[\\/]hosts\b/i,
    description: '改写 hosts',
    risk: 'medium'
  },
  {
    name: 'eval_var',
    pattern: /\beval\s+(\$[A-Za-z_]|\$\{)/,
    description: 'eval 变量展开',
    risk: 'high'
  },
  {
    name: 'windows_format_c',
    pattern: /\bformat\s+[cC]:\b|\bRemove-Item\s+.*-Recurse\s+.*[cC]:\\?\s*$/i,
    description: 'Windows 格式化/清空 C 盘',
    risk: 'critical'
  },
  {
    name: 'del_system32',
    pattern: /\b(del|rmdir|Remove-Item)\b[^;|]*System32/i,
    description: '删除 System32',
    risk: 'critical'
  }
];

const RISK_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * @param {string} text
 * @returns {Array<{ name: string, description: string, risk: RiskLevel }>}
 */
export function scanTextForThreats(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const hits = [];
  for (const p of TOOL_THREAT_PATTERNS) {
    try {
      if (p.pattern.test(s)) {
        hits.push({ name: p.name, description: p.description, risk: p.risk });
      }
      p.pattern.lastIndex = 0;
    } catch {
      /* ignore bad pattern */
    }
  }
  hits.sort((a, b) => (RISK_RANK[b.risk] || 0) - (RISK_RANK[a.risk] || 0));
  return hits;
}

/** @param {RiskLevel} a @param {RiskLevel} b */
export function maxRisk(a, b) {
  return (RISK_RANK[a] || 0) >= (RISK_RANK[b] || 0) ? a : b;
}
