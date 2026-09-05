// @ts-nocheck
/**
 * 脱敏（对齐 agent-zero compact：摘要/备份不落明文密钥）。
 */

const SECRET_PATTERNS = [
  /\b(sk-[a-zA-Z0-9_-]{10,})\b/g,
  /\b(sk-ant-[a-zA-Z0-9_-]{10,})\b/g,
  /\b(ghp_[a-zA-Z0-9]{20,})\b/g,
  /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g,
  /\b(xox[baprs]-[a-zA-Z0-9-]{10,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(AIza[0-9A-Za-z_-]{20,})\b/g,
  /(?:"|')?(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|private[_-]?key)(?:"|')?\s*[:=]\s*(?:"|')?([^\s"',]{8,})(?:"|')?/gi,
  /Bearer\s+[A-Za-z0-9._\-+/=]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi
];

/**
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let s = String(text ?? '');
  if (!s) return '';
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (match) => {
      if (/^Bearer\s+/i.test(match)) return 'Bearer [REDACTED]';
      if (/BEGIN .*PRIVATE KEY/i.test(match)) return '[REDACTED PRIVATE KEY]';
      if (/api[_-]?key|access[_-]?token|secret|password|private[_-]?key/i.test(match)) {
        return match.replace(/([:=]\s*)(["']?)([^\s"',]{8,})\2/i, '$1$2[REDACTED]$2');
      }
      return '[REDACTED]';
    });
  }
  return s;
}
