/**
 * 群/会话笔录单例。
 * ChatStream 经 FileLoader `?t=` 热重载会生成新模块实例；历史必须放在不被 cache-bust 的模块里。
 */
export const chatSessionHistory = new Map<string, unknown>();
