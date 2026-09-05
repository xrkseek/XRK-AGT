import path from 'node:path';
import { RuntimeError, ErrorCodes } from '#utils/error-handler.js';
import { isPathInside, realpathSyncOrResolve } from '#utils/path-guards.js';

/**
 * 输入验证器
 * 提供统一的输入验证和安全检查
 */
export class InputValidator {
  /**
   * 验证文件路径落在 baseDir 内。
   * 相对路径相对 baseDir 解析；绝对路径允许，但必须仍在 baseDir 内
   *（multer / sendFile 等场景给出的就是绝对路径）。
   * 真正防穿越靠 isPathInside，勿把「绝对路径」或文件名里的 `..` 子串当成穿越。
   */
  static validatePath(filePath: unknown, baseDir: string = process.cwd()): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new RuntimeError('路径必须是字符串', ErrorCodes.INVALID_INPUT);
    }

    let candidate = filePath;
    try {
      candidate = decodeURIComponent(filePath);
    } catch {
      candidate = filePath;
    }
    if (/\0/.test(candidate)) {
      throw new RuntimeError(
        `无效的路径: ${filePath} (检测到非法字符)`,
        ErrorCodes.PATH_TRAVERSAL,
      );
    }

    const normalized = path.normalize(candidate);
    const baseResolved = realpathSyncOrResolve(baseDir);
    const resolved = path.isAbsolute(normalized)
      ? realpathSyncOrResolve(normalized)
      : realpathSyncOrResolve(path.resolve(baseResolved, normalized));

    if (!isPathInside(baseResolved, resolved)) {
      throw new RuntimeError(`路径超出允许范围: ${filePath}`, ErrorCodes.INVALID_PATH);
    }

    return resolved;
  }

  /**
   * 校验绝对路径是否位于允许的根目录之一
   */
  static assertPathUnderRoots(filePath: unknown, allowedRoots: string[] | null | undefined): string {
    if (!filePath || typeof filePath !== 'string') {
      throw new RuntimeError('路径必须是字符串', ErrorCodes.INVALID_INPUT);
    }
    const normalized = path.normalize(filePath);
    if (!path.isAbsolute(normalized)) {
      throw new RuntimeError('只支持绝对路径', ErrorCodes.INVALID_PATH);
    }
    const resolved = realpathSyncOrResolve(normalized);
    const roots = (allowedRoots || []).map((r) => realpathSyncOrResolve(r));
    const allowed = roots.some((base) => isPathInside(base, resolved));
    if (!allowed) {
      throw new RuntimeError('访问被拒绝：路径不在允许的数据目录内', ErrorCodes.INVALID_PATH);
    }
    return resolved;
  }

  /**
   * 验证命令
   * 防止执行危险命令
   */
  static validateCommand(command: unknown): string {
    if (!command || typeof command !== 'string') {
      throw new RuntimeError('命令必须是字符串', ErrorCodes.INVALID_INPUT);
    }

    const dangerousPatterns = [
      /rm\s+-rf/i,
      /format\s+/i,
      /del\s+\/f/i,
      /rmdir\s+\/s/i,
      /mkfs/i,
      /dd\s+if=/i,
      />\s*\/dev/i,
      /\|\s*sh\s*$/i,
      /\|\s*bash\s*$/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        throw new RuntimeError(`禁止执行危险命令: ${command}`, ErrorCodes.INVALID_COMMAND);
      }
    }

    return command.trim();
  }

  /**
   * 验证用户ID
   */
  static validateUserId(userId: unknown): string {
    if (!userId) {
      throw new RuntimeError('用户ID不能为空', ErrorCodes.INVALID_INPUT);
    }

    const idStr = String(userId);
    if (!/^\d+$/.test(idStr)) {
      throw new RuntimeError(`无效的用户ID格式: ${userId}`, ErrorCodes.INVALID_INPUT);
    }

    return idStr;
  }

  /**
   * 验证端口号
   */
  static validatePort(port: unknown): number {
    const portNum = parseInt(String(port), 10);

    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new RuntimeError(`无效的端口号: ${port} (范围: 1-65535)`, ErrorCodes.INVALID_INPUT);
    }

    return portNum;
  }

  /**
   * 验证URL
   */
  static validateUrl(url: unknown): string {
    if (!url || typeof url !== 'string') {
      throw new RuntimeError('URL必须是字符串', ErrorCodes.INVALID_INPUT);
    }

    try {
      const urlObj = new URL(url);

      // 只允许 http 和 https
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new RuntimeError(`不支持的协议: ${urlObj.protocol}`, ErrorCodes.INVALID_INPUT);
      }

      return url;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(`无效的URL格式: ${url}`, ErrorCodes.INVALID_INPUT);
    }
  }

  /**
   * 验证JSON字符串
   */
  static validateJson(jsonString: unknown): unknown {
    if (!jsonString || typeof jsonString !== 'string') {
      throw new RuntimeError('JSON必须是字符串', ErrorCodes.INVALID_INPUT);
    }

    try {
      return JSON.parse(jsonString);
    } catch (error) {
      throw new RuntimeError(
        `无效的JSON格式: ${normalizeMessage(error)}`,
        ErrorCodes.INVALID_INPUT,
      );
    }
  }

  /**
   * 清理和验证文本输入
   */
  static sanitizeText(text: unknown, maxLength = 10000): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    // 移除控制字符（保留换行和制表符）
    let sanitized = text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    // 限制长度
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength) + '...(已截断)';
    }

    return sanitized.trim();
  }

  /**
   * 验证API密钥
   */
  static validateApiKey(apiKey: unknown): string {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new RuntimeError('API密钥必须是字符串', ErrorCodes.INVALID_INPUT);
    }

    if (apiKey.length < 16 || apiKey.length > 256) {
      throw new RuntimeError('API密钥长度必须在16-256字符之间', ErrorCodes.INVALID_INPUT);
    }

    return apiKey;
  }
}

function normalizeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
