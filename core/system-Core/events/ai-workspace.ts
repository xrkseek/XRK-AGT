// @ts-nocheck
import ListenerBase from '#infrastructure/listener/base.js';
import { installMcpAuditHook } from '../lib/ai-workspace-context.js';

/** 启动时尝试挂载 MCP 工具审计 */
export default class AiWorkspaceEvent extends ListenerBase {
  constructor() {
    super('ai-workspace');
  }

  async init() {
    installMcpAuditHook();
  }
}
