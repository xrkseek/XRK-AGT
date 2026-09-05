// @ts-nocheck
import { spawn } from 'node:child_process';
import RuntimeUtil from '#utils/runtime-util.js';
import { resolveCommandSpawn } from '#utils/command-spawn.js';
import { fetchWithPolicy } from '#utils/fetch-with-retry.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { checkMcpConnectAllowed } from '#utils/runtime-policy.js';

/**
 * 远程 MCP 客户端宿主：stdio / HTTP / WebSocket transport，
 * 以及插件式 MCP 服务器的加载与工具注册。
 *
 * 通过依赖注入绑定 AiWorkflowLoader（mcpServer / mcpPluginServers / 日志）。
 */
export class RemoteMcpController {
  remoteMCPServers = new Map();
  _loadedPluginServers = new Set();
  _nextRemoteRequestId = 1;
  _getMcpServer: any;
  _getMcpPluginServers: any;
  _makeLog: any;
  _registerToolCallback: any;

  /**
   * @param {object} deps
   * @param {() => import('#utils/mcp-server.js').MCPServer | null | undefined} deps.getMcpServer
   * @param {() => Map<string, object>} [deps.getMcpPluginServers]
   * @param {(level: string, message: string, error?: any) => void} [deps.makeLog]
   * @param {(name: string, def: object) => void} [deps.registerTool] 可选；默认走 mcpServer.registerTool
   */
  constructor({ getMcpServer, getMcpPluginServers, makeLog, registerTool }: any = {}) {
    this._getMcpServer = typeof getMcpServer === 'function' ? getMcpServer : () => null;
    this._getMcpPluginServers = typeof getMcpPluginServers === 'function'
      ? getMcpPluginServers
      : () => new Map();
    this._makeLog = typeof makeLog === 'function'
      ? makeLog
      : (level: any, message: any, error: any) => RuntimeUtil.makeLog(level, message, 'RemoteMcp', error);
    this._registerToolCallback = typeof registerTool === 'function' ? registerTool : null;
  }

  get mcpServer() {
    return this._getMcpServer();
  }

  get mcpPluginServers() {
    return this._getMcpPluginServers();
  }

  _makeRemoteRequestId() {
    // 保持为安全整数，避免长时间运行溢出
    const id = this._nextRemoteRequestId++;
    if (this._nextRemoteRequestId > 1_000_000_000) this._nextRemoteRequestId = 1;
    return id;
  }

  _createDeferred() {
    /** @type {(value:any)=>void} */
    let resolve;
    /** @type {(reason:any)=>void} */
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  _disposeRemoteMCPServer(serverName: any) {
    const server = this.remoteMCPServers.get(serverName);
    if (!server) return;

    if (server.type === 'stdio' && server.process) {
      const client = server._stdioClient;
      if (client?.pending) {
        for (const [, pending] of client.pending.entries()) {
          if (pending.timeout) clearTimeout(pending.timeout);
          try { pending.reject(new Error('远程MCP已卸载')); } catch {}
        }
        client.pending.clear();
      }
      if (client?.onData) {
        try { server.process.stdout?.removeListener('data', client.onData); } catch {}
      }
      try {
        server.process.stdin?.end?.();
        server.process.kill('SIGTERM');
      } catch {}
    }

    this.remoteMCPServers.delete(serverName);
    this._loadedPluginServers.delete(serverName);
  }

  async _disposeAllRemoteMCPServers() {
    for (const name of [...this.remoteMCPServers.keys()]) {
      this._disposeRemoteMCPServer(name);
    }
    this._loadedPluginServers.clear();
  }

  _ensureStdioClient(_serverName: any, entry: any) {
    if (!entry || entry.type !== 'stdio' || !entry.process) return null;
    if (entry._stdioClient) return entry._stdioClient;

    const child = entry.process;
    const client = {
      buffer: '',
      stderr: '',
      pending: new Map(),
      onData: null,
      closed: false
    };

    const flushPending = (errMsg) => {
      for (const [_id, p] of client.pending.entries()) {
        try { p.reject(new Error(errMsg)); } catch {}
      }
      client.pending.clear();
    };

    client.onData = (data) => {
      if (client.closed) return;
      client.buffer += data?.toString?.() || '';
      const lines = client.buffer.split('\n');
      client.buffer = lines.pop() || '';

      for (const line of lines) {
        const s = String(line || '').trim();
        if (!s) continue;
        let msg;
        try { msg = JSON.parse(s); } catch { continue; }
        const id = msg?.id;
        if (!id) continue;
        const pending = client.pending.get(id);
        if (!pending) continue;
        client.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (msg.error) {
          pending.reject(new Error(msg.error?.message || '远程MCP返回错误'));
        } else {
          pending.resolve(msg.result);
        }
      }
    };

    child.stdout?.on('data', client.onData);
    child.stderr?.on('data', (chunk) => {
      const text = chunk?.toString?.() || '';
      client.stderr = (client.stderr + text).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      client.closed = true;
      try { child.stdout?.removeListener('data', client.onData); } catch {}
      const detail = client.stderr.trim().replace(/\s+/g, ' ').slice(0, 400);
      const why = [
        '远程MCP进程已退出',
        code != null ? `code=${code}` : null,
        signal ? `signal=${signal}` : null,
        detail || null,
      ].filter(Boolean).join(' | ');
      flushPending(why);
    });
    child.on('error', (err) => {
      client.closed = true;
      try { child.stdout?.removeListener('data', client.onData); } catch {}
      flushPending(err?.message || '远程MCP进程错误');
    });

    entry._stdioClient = client;
    return client;
  }

  async _stdioRequest(serverName: any, entry: any, method: any, params: any, { timeoutMs = 15000 }: any = {}) {
    const client = this._ensureStdioClient(serverName, entry);
    if (!client || client.closed) {
      throw new Error(`远程MCP服务器 ${serverName} 不可用`);
    }
    const id = this._makeRemoteRequestId();
    const deferred = this._createDeferred();
    const timeout = setTimeout(() => {
      client.pending.delete(id);
      deferred.reject(new Error('调用超时'));
    }, Math.max(1000, Number(timeoutMs) || 15000));

    client.pending.set(id, { ...deferred, timeout });

    const request = { jsonrpc: '2.0', id, method, params: params || {} };
    entry.process.stdin.write(JSON.stringify(request) + '\n');
    return deferred.promise;
  }

  /**
   * 获取远程MCP配置和选中的服务器名称集合
   */
  _getRemoteMCPConfig() {
    const remoteConfig = getAiWorkflowConfigOptional().mcp?.remote || {};
    if (!remoteConfig.enabled) return null;
    const blocks = Array.isArray(remoteConfig.mcpServers) ? remoteConfig.mcpServers : [];
    if (!blocks.length) return null;

    const merged = {};
    const mergeServers = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      const map = obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
        ? obj.mcpServers
        : null;
      if (!map) return;
      for (const [name, runtimeConfig] of Object.entries(map)) {
        const n = String(name || '').trim();
        if (!n || !runtimeConfig || typeof runtimeConfig !== 'object') continue;
        merged[n] = runtimeConfig;
      }
    };

    for (const block of blocks) {
      let obj = block?.config ?? block;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); } catch { obj = null; }
      }
      mergeServers(obj);
    }

    const servers = Object.entries(merged)
      .map(([name, runtimeConfig]) => ({ name, runtimeConfig }))
      .filter(item => item.name && item.runtimeConfig && typeof item.runtimeConfig === 'object');

    return servers.length ? { servers } : null;
  }

  /**
   * 加载远程MCP服务器并注册工具
   */
  async loadRemoteMCPServers() {
    if (!this.mcpServer) return [];
    if (process.env.XRK_TEST === '1') return [];

    const loadedServers = [];

    // 1) 先加载由 stream 插件提供的 MCP 服务器（安装插件即自动注册）
    for (const [serverName, runtimeConfig] of this.mcpPluginServers.entries()) {
      if (this._loadedPluginServers.has(serverName)) continue;
      try {
        await this._createRemoteMCPClient(serverName, runtimeConfig || {});
        this._loadedPluginServers.add(serverName);
        this._makeLog('info', `插件 MCP 服务器已加载: ${serverName}`);
        loadedServers.push(serverName);
      } catch (error: any) {
        this._makeLog('warn', `加载插件 MCP 服务器 ${serverName} 失败: ${error.message}`);
      }
    }

    // 2) 再加载 ai-workflow.yaml 中配置的远程 MCP 服务器
    const config = this._getRemoteMCPConfig();
    const yamlNames = new Set(
      (config?.servers || []).map((item) => String(item?.name || '').trim()).filter(Boolean)
    );

    for (const name of [...this.remoteMCPServers.keys()]) {
      if (!this._loadedPluginServers.has(name) && !yamlNames.has(name)) {
        this._disposeRemoteMCPServer(name);
      }
    }

    if (!config) return loadedServers;

    const { servers } = config;

    for (const serverConfig of servers) {
      const serverName = String(serverConfig.name || '').trim();
      if (!serverName) continue;

      try {
        // 串行逐个加载，避免同时启动大量 stdio 子进程导致 CPU 峰值
        await this._createRemoteMCPClient(serverName, serverConfig.runtimeConfig || {});
        loadedServers.push(serverName);
      } catch (error: any) {
        this._makeLog('error', `加载远程MCP服务器 ${serverName} 失败: ${error.message}`);
      }
    }

    return loadedServers;
  }

  /**
   * 获取已加载的远程 MCP 服务器名称列表
   * 用于在 /api/ai/models 暴露为“可选工作流”，让前端显式勾选启用。
   */
  listRemoteMCPServers() {
    const names = new Set([...this.mcpPluginServers.keys(), ...this.remoteMCPServers.keys()]);
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /**
   * 创建远程MCP客户端并注册工具
   */
  async _createRemoteMCPClient(serverName: any, config: any) {
    const connectGate = checkMcpConnectAllowed(serverName);
    if (!connectGate.ok) {
      this._makeLog('warn', connectGate.error);
      return;
    }

    const runtimeConfig = config && typeof config === 'object' ? config : {};
    this._disposeRemoteMCPServer(serverName);

    if (runtimeConfig.command) {
      // stdio 协议：通过子进程启动 MCP 服务器
      // Windows 下 npx/npm 等常为 .cmd，裸 spawn 会 ENOENT；统一走 command-spawn
      // 显式 shell: true 仅用于管道等特殊语法；已解析为 cmd.exe 时保持 shell:false
      const cwd = typeof runtimeConfig.cwd === 'string' && runtimeConfig.cwd.trim()
        ? runtimeConfig.cwd.trim()
        : process.cwd();
      const args = (Array.isArray(runtimeConfig.args) ? runtimeConfig.args : []).map((a) => String(a));
      const spawnSpec = resolveCommandSpawn(String(runtimeConfig.command), args, cwd);
      const shell = typeof runtimeConfig.shell === 'boolean'
        ? runtimeConfig.shell
        : spawnSpec.shell;
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell,
        windowsHide: true,
        env: { ...process.env, ...(runtimeConfig.env && typeof runtimeConfig.env === 'object' ? runtimeConfig.env : {}) },
        cwd,
      });
      const entry = { type: 'stdio', process: child, config: runtimeConfig };
      this.remoteMCPServers.set(serverName, entry);

      // 使用单一 stdout listener + pending map，避免超时/并发造成 listener 泄漏
      this._ensureStdioClient(serverName, entry);

      try {
        const initParams = {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'xrk-agt', version: '1.0.0' }
        };
        // npx -y 首次拉包可能较慢
        const cmd = String(runtimeConfig.command || '').toLowerCase();
        const initTimeoutMs = (cmd === 'npx' || cmd.endsWith('\\npx') || cmd.endsWith('/npx') || cmd.endsWith('npx.cmd'))
          ? 90000
          : 15000;
        await this._stdioRequest(serverName, entry, 'initialize', initParams, { timeoutMs: initTimeoutMs });
        const listResult = await this._stdioRequest(serverName, entry, 'tools/list', {}, { timeoutMs: 30000 });
        if (listResult?.tools) {
          this._registerRemoteTools(serverName, listResult.tools);
        }
      } catch (error: any) {
        this._makeLog('error', `远程MCP服务器 ${serverName} 初始化失败: ${error.message}`);
        throw error;
      }
    } else if (runtimeConfig.url) {
      // URL 协议：支持 HTTP / WebSocket 等远程 MCP transport
      const headers = runtimeConfig.headers && typeof runtimeConfig.headers === 'object' ? runtimeConfig.headers : {};
      const transport = String(runtimeConfig.transport || 'http').toLowerCase();

      if (transport === 'websocket' || transport === 'ws') {
        this.remoteMCPServers.set(serverName, { type: 'ws', url: runtimeConfig.url, headers, config: runtimeConfig });
        await this._fetchRemoteToolsViaWebSocket(serverName, { url: runtimeConfig.url, headers });
      } else {
        // 默认按 HTTP JSON-RPC 处理，包括 transport=http/sse/空
        this.remoteMCPServers.set(serverName, { type: 'http', url: runtimeConfig.url, headers, config: runtimeConfig });
        await this._fetchRemoteTools(serverName, { ...runtimeConfig, headers });
      }
    }
  }

  /**
   * 注册远程MCP工具到主MCP服务器
   */
  _registerRemoteTools(serverName: any, tools: any) {
    const mcpServer = this.mcpServer;
    if (!mcpServer || !Array.isArray(tools)) return;

    const before = mcpServer.tools.size;
    for (const tool of tools) {
      const toolName = `remote-mcp.${serverName}.${tool.name}`;
      // 如果工具已存在，先删除再注册（避免重复警告）
      if (mcpServer.tools.has(toolName)) {
        mcpServer.tools.delete(toolName);
      }
      const def = {
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
        handler: (args) => this._callRemoteTool(serverName, tool.name, args)
      };
      if (this._registerToolCallback) {
        this._registerToolCallback(toolName, def);
      } else {
        mcpServer.registerTool(toolName, def);
      }
    }
    const added = mcpServer.tools.size - before;
    if (added > 0) {
      this._makeLog('info', `远程 MCP 工具已注册: ${serverName} (${added}个)`);
    }
  }

  /**
   * 归一化远程 MCP 返回结果（stdio / HTTP 共用）
   * @private
   */
  _normalizeRemoteMCPResult(rawResult: any) {
    try {
      const text = rawResult?.content?.[0]?.text;

      if (typeof text === 'string' && text.trim().length > 0) {
        // 优先尝试把 text 当作 JSON 解析；失败则当作原始字符串返回
        try {
          return JSON.parse(text);
        } catch {
          return { success: true, raw: text };
        }
      }

      if (rawResult !== undefined) {
        return rawResult;
      }

      return { success: false, error: '远程MCP返回空结果' };
    } catch (e: any) {
      return { success: false, error: `解析远程MCP响应失败: ${e.message || e}` };
    }
  }

  /**
   * 调用远程 MCP 工具（stdio / HTTP / WebSocket）
   */
  async _callRemoteTool(serverName: any, toolName: any, args: any) {
    const server = this.remoteMCPServers.get(serverName);
    if (!server) {
      return { success: false, error: `远程MCP服务器 ${serverName} 未找到` };
    }

    if (server.type === 'stdio') {
      try {
        const result = await this._stdioRequest(
          serverName,
          server,
          'tools/call',
          { name: toolName, arguments: args },
          { timeoutMs: 30000 }
        );
        return this._normalizeRemoteMCPResult(result);
      } catch (error: any) {
        return { success: false, error: error.message || String(error) };
      }
    } else if (server.type === 'http') {
      try {
        const requestId = this._makeRemoteRequestId();
        const request = { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: toolName, arguments: args } };
        const response = await fetchWithPolicy(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...server.headers },
          body: JSON.stringify(request),
          timeoutMs: 30_000,
        });
        const data = await response.json();
        return this._normalizeRemoteMCPResult(data.result);
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    } else if (server.type === 'ws') {
      // 简单 WebSocket JSON-RPC 客户端：每次调用按需建立连接
      try {
        const { default: WebSocket } = await import('ws');
        const requestId = this._makeRemoteRequestId();
        const request = { jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: toolName, arguments: args } };
        return await new Promise((resolve) => {
          const ws = new WebSocket(server.url, { headers: server.headers || {} });
          const timeout = setTimeout(() => {
            try { ws.close(); } catch {}
            resolve({ success: false, error: '调用超时' });
          }, 30000);

          ws.on('open', () => {
            ws.send(JSON.stringify(request));
          });

          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.id !== requestId) return;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              const finalResult = this._normalizeRemoteMCPResult(msg.result);
              resolve(finalResult);
            } catch {
              // 忽略解析失败，继续等待下一条
            }
          });

          ws.on('error', (err) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err?.message || String(err) });
          });

          ws.on('close', () => {
            // 如果在超时前关闭且尚未返回，则以通用错误结束
            clearTimeout(timeout);
          });
        });
      } catch (error: any) {
        return { success: false, error: error.message || String(error) };
      }
    }
  }

  /**
   * 通过 HTTP 获取远程工具列表
   */
  async _fetchRemoteTools(serverName: any, config: any) {
    try {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      const response = await fetchWithPolicy(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
        body: JSON.stringify(request),
        timeoutMs: 30_000,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      }
      const data = await response.json();
      if (data.result?.tools) {
        this._registerRemoteTools(serverName, data.result.tools);
      } else if (data.error) {
        throw new Error(data.error?.message || JSON.stringify(data.error));
      }
    } catch (error: any) {
      this._makeLog('error', `获取远程MCP工具失败 ${serverName}: ${error.message}`);
    }
  }

  /**
   * 通过 WebSocket 获取远程工具列表（MCP JSON-RPC over WS）
   */
  async _fetchRemoteToolsViaWebSocket(serverName: any, config: any) {
    try {
      const { default: WebSocket } = await import('ws');
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

      await new Promise((resolve) => {
        const ws = new WebSocket(config.url, { headers: config.headers || {} });
        const timeout = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve();
        }, 15000);

        ws.on('open', () => {
          ws.send(JSON.stringify(request));
        });

        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id !== 1) return;
            if (msg.result?.tools) {
              this._registerRemoteTools(serverName, msg.result.tools);
            }
          } catch {
            // 忽略解析失败
          } finally {
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            resolve();
          }
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve();
        });

        ws.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (error: any) {
      this._makeLog('error', `通过 WebSocket 获取远程MCP工具失败 ${serverName}: ${error.message}`);
    }
  }
}

export default RemoteMcpController;
