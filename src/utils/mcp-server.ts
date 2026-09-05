import RuntimeUtil from '#utils/runtime-util.js';
import { summarizeToolResultText } from '#utils/mcp-tool-result-text.js';
import { inspectToolCallSecurity } from '#utils/security/tool-security-inspect.js';
import { parseToolCallArguments, toolArgumentsParseHint } from '#utils/llm/parse-tool-arguments.js';
import os from 'os';

type JsonSchemaProperty = {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
};

type McpToolDefinition = {
  description?: string;
  inputSchema?: JsonSchema;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

type McpResourceDefinition = {
  name?: string;
  description?: string;
  mimeType?: string;
  handler?: () => unknown | Promise<unknown>;
};

type RegisteredResource = {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler?: () => unknown | Promise<unknown>;
};

type McpPromptDefinition = {
  description?: string;
  arguments?: unknown[];
  handler?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

type RegisteredPrompt = {
  name: string;
  description: string;
  arguments: unknown[];
  handler?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

type ToolCallRequest = {
  name: string;
  arguments?: unknown;
};

type McpContentItem = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type McpToolResult = {
  content: McpContentItem[];
  isError?: boolean;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcOptions = {
  stream?: string | null;
};

type SecurityInspectResult = {
  ok: boolean;
  error?: string;
  findings?: unknown;
  warnings?: string[];
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/**
 * Model Context Protocol (MCP) 服务器实现
 * 符合 MCP 2025-11-25，基于 JSON-RPC 2.0
 *
 * - 工作流 `registerMCPTool` 统一挂到本服务器，对外暴露给 LLM / Cursor / HTTP·WS·SSE
 * - **执行前门禁**：`handleToolCall` 内 `inspectToolCallSecurity`（policies + toolScan + 可选审批）
 *   覆盖所有调用路径，避免只拦 LLM 适配器
 *
 * 参考：https://modelcontextprotocol.io/specification/2025-11-25
 */
export class MCPServer {
  tools = new Map<string, RegisteredTool>();
  resources = new Map<string, RegisteredResource>();
  prompts = new Map<string, RegisteredPrompt>();
  initialized = false;
  serverInfo = {
    name: 'xrk-agt-mcp-server',
    version: '1.0.5',
    protocolVersion: '2025-11-25',
  };
  stream: unknown;

  constructor(streamInstance: unknown = null) {
    this.stream = streamInstance;
    this.registerCoreTools();
  }

  /**
   * 注册MCP工具
   */
  registerTool(name: string, tool: McpToolDefinition): void {
    if (this.tools.has(name)) {
      // 热重载覆盖：默认 warn，便于发现同名冲突；DEBUG_MCP_TOOLS=1 时附带 debug
      RuntimeUtil.makeLog('warn', `MCP 工具覆盖: ${name}`, 'MCPServer');
      if (process.env.DEBUG_MCP_TOOLS) {
        RuntimeUtil.makeLog('debug', `MCP工具覆盖详情: ${name}`, 'MCPServer');
      }
    }

    this.tools.set(name, {
      name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
      handler: tool.handler,
    });
  }

  /**
   * 注册MCP资源
   */
  registerResource(uri: string, resource: McpResourceDefinition): void {
    this.resources.set(uri, {
      uri,
      name: resource.name || uri,
      description: resource.description || '',
      mimeType: resource.mimeType || 'text/plain',
      handler: resource.handler,
    });
    RuntimeUtil.makeLog('debug', `MCP资源已注册: ${uri}`, 'MCPServer');
  }

  /**
   * 注册MCP提示词
   */
  registerPrompt(name: string, prompt: McpPromptDefinition): void {
    this.prompts.set(name, {
      name,
      description: prompt.description || '',
      arguments: prompt.arguments || [],
      handler: prompt.handler,
    });
    RuntimeUtil.makeLog('debug', `MCP提示词已注册: ${name}`, 'MCPServer');
  }

  /**
   * 处理 MCP 工具调用（符合 MCP 标准）
   *
   * 顺序：工具存在性 → **安全/策略检查** → inputSchema 校验 → handler → 结果投影。
   * 返回：`{ content: [{ type:'text', text }], isError }`；结构化结果经 `summarizeToolResultText`。
   */
  async handleToolCall(request: ToolCallRequest): Promise<McpToolResult> {
    const { name, arguments: args } = request;

    if (!this.tools.has(name)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: {
                  code: -32601,
                  message: `工具未找到: ${name}`,
                  timestamp: Date.now(),
                },
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const tool = this.tools.get(name)!;
    const isRemote = name.startsWith('remote-mcp.');
    const parsedArgs = parseToolCallArguments(args);
    if (!parsedArgs.ok) {
      RuntimeUtil.makeLog(
        'warn',
        `MCP 工具参数解析失败: ${name}: ${parsedArgs.error} | snippet=${parsedArgs.snippet}`,
        'MCPServer',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: toolArgumentsParseHint(parsedArgs.error),
                snippet: parsedArgs.snippet,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    const callArgs = parsedArgs.args;

    RuntimeUtil.makeLog(
      'info',
      `MCP 工具调用开始: ${name}${isRemote ? ' (remote)' : ''} keys=[${Object.keys(callArgs).join(',')}]`,
      'MCPServer',
    );

    try {
      const security = (await inspectToolCallSecurity(name, callArgs)) as SecurityInspectResult;
      if (!security.ok) {
        RuntimeUtil.makeLog('warn', `MCP 工具调用被安全/策略拦截: ${name}`, 'MCPServer');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: security.error,
                  findings: security.findings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // 验证参数schema（如果提供）
      if (tool.inputSchema && tool.inputSchema.properties) {
        this.validateArguments(callArgs, tool.inputSchema);
      }

      // 调用工具handler
      const result = (await tool.handler(callArgs)) as Record<string, unknown> | null;

      // 格式化响应（符合MCP标准）
      // 如果result已经是MCP标准格式（有content数组），直接返回
      if (result && typeof result === 'object' && Array.isArray(result.content)) {
        return {
          content: result.content as McpContentItem[],
          isError: (result.isError as boolean) || false,
        };
      }

      // 检查是否为错误结果
      const isError = !!(result && typeof result === 'object' && result.success === false);

      RuntimeUtil.makeLog(
        isError ? 'warn' : 'info',
        `MCP 工具调用完成: ${name}${isRemote ? ' (remote)' : ''}, isError=${isError}`,
        'MCPServer',
      );

      const text = summarizeToolResultText(result);
      return {
        content: [{ type: 'text', text }],
        isError,
      };
    } catch (error) {
      RuntimeUtil.makeLog('error', `MCP工具调用失败[${name}]: ${errMessage(error)}`, 'MCPServer');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: {
                  code: -32603,
                  message: errMessage(error),
                  data: { tool: name, arguments: args },
                  timestamp: Date.now(),
                },
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * 验证工具参数（基于JSON Schema）
   */
  validateArguments(args: Record<string, unknown>, schema: JsonSchema): void {
    if (!schema.properties) return;

    // 检查必需参数
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in args) || args[required] === undefined || args[required] === null) {
          const hint = args && typeof args.raw === 'string' ? '（收到未解析的 raw 字符串，请检查 arguments JSON）' : '';
          throw new Error(`缺少必需参数: ${required}${hint}`);
        }
      }
    }

    // 验证参数类型
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key];
      if (propSchema) {
        const expectedType = propSchema.type;
        const actualType = Array.isArray(value) ? 'array' : typeof value;

        if (expectedType && actualType !== expectedType && expectedType !== 'object') {
          throw new Error(`参数 ${key} 类型不匹配: 期望 ${expectedType}, 实际 ${actualType}`);
        }
      }
    }
  }

  /**
   * 获取所有可用工具列表（符合MCP标准）
   * @param streamName - 可选：工作流名称，如果提供则只返回该工作流的工具
   */
  listTools(streamName: string | null = null): Array<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
  }> {
    const tools = Array.from(this.tools.values());

    // 如果指定了工作流名称，只返回该工作流的工具
    if (streamName) {
      const prefix = `${streamName}.`;
      return tools
        .filter((tool) => tool.name.startsWith(prefix))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: [],
          },
        }));
    }

    // 默认情况下，全局工具列表中隐藏 chat 工作流的 MCP 工具，
    // 避免在标准 JSON-RPC 接口和 LLM 工具注入时暴露群管相关能力。
    return tools
      .filter((tool) => !tool.name.startsWith('chat.'))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || {
          type: 'object',
          properties: {},
          required: [],
        },
      }));
  }

  /**
   * 获取所有工作流分组
   * @returns 工作流分组，格式：{ workflowName: [tools...] }
   */
  listToolsByWorkflow(): Record<
    string,
    Array<{
      name: string;
      description: string;
      inputSchema: JsonSchema;
    }>
  > {
    const groups: Record<
      string,
      Array<{
        name: string;
        description: string;
        inputSchema: JsonSchema;
      }>
    > = {};

    for (const tool of this.tools.values()) {
      const parts = tool.name.split('.');
      if (parts.length >= 2) {
        const workflowName = parts[0];
        if (!groups[workflowName]) {
          groups[workflowName] = [];
        }
        groups[workflowName].push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema || {
            type: 'object',
            properties: {},
            required: [],
          },
        });
      }
    }

    return groups;
  }

  /**
   * 获取工作流列表
   */
  listWorkflows(): string[] {
    const workflows = new Set<string>();

    for (const tool of this.tools.values()) {
      const parts = tool.name.split('.');
      if (parts.length >= 2) {
        workflows.add(parts[0]);
      }
    }

    return Array.from(workflows);
  }

  /**
   * 获取所有可用资源列表（符合MCP标准）
   */
  listResources(): Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }> {
    return Array.from(this.resources.values()).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));
  }

  /**
   * 获取资源内容
   */
  async getResource(uri: string): Promise<{
    uri: string;
    mimeType: string;
    text: string;
  }> {
    if (!this.resources.has(uri)) {
      throw new Error(`资源未找到: ${uri}`);
    }

    const resource = this.resources.get(uri)!;
    if (resource.handler) {
      const content = await resource.handler();
      return {
        uri,
        mimeType: resource.mimeType,
        text: typeof content === 'string' ? content : JSON.stringify(content),
      };
    }

    return {
      uri,
      mimeType: resource.mimeType,
      text: '',
    };
  }

  /**
   * 获取所有可用提示词列表（符合MCP标准）
   */
  listPrompts(): Array<{
    name: string;
    description: string;
    arguments: unknown[];
  }> {
    return Array.from(this.prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments || [],
    }));
  }

  /**
   * 获取提示词内容
   */
  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    name: string;
    description: string;
    messages: unknown[];
  }> {
    if (!this.prompts.has(name)) {
      throw new Error(`提示词未找到: ${name}`);
    }

    const prompt = this.prompts.get(name)!;
    if (prompt.handler) {
      const content = (await prompt.handler(args)) as { messages?: unknown[] } | string | Record<string, unknown>;
      return {
        name,
        description: prompt.description,
        messages: Array.isArray((content as { messages?: unknown[] }).messages)
          ? (content as { messages: unknown[] }).messages
          : [{ role: 'user', content: typeof content === 'string' ? content : JSON.stringify(content) }],
      };
    }

    return {
      name,
      description: prompt.description,
      messages: [],
    };
  }

  /**
   * 处理JSON-RPC请求（MCP标准）
   * @param options.stream - 可选：工作流名称，用于过滤工具
   */
  async handleJSONRPC(
    request: JsonRpcRequest,
    options: JsonRpcOptions = {},
  ): Promise<{
    jsonrpc: string;
    id?: string | number | null;
    result?: unknown;
    error?: { code: number; message: string };
  }> {
    const { jsonrpc, id, method, params } = request;
    const { stream } = options;

    // 验证JSON-RPC版本
    if (jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid Request: jsonrpc must be "2.0"',
        },
      };
    }

    try {
      let result: unknown;

      switch (method) {
        case 'initialize':
          result = await this.handleInitialize(params);
          this.initialized = true;
          break;

        case 'tools/list':
          // 支持按工作流过滤工具
          result = { tools: stream ? this.listTools(stream) : this.listTools() };
          break;

        case 'tools/call':
          if (!params || !params.name) {
            throw new Error('工具名称不能为空');
          }
          result = await this.handleToolCall({
            name: params.name as string,
            arguments: params.arguments || {},
          });
          break;

        case 'resources/list':
          result = { resources: this.listResources() };
          break;

        case 'resources/read':
          if (!params || !params.uri) {
            throw new Error('资源URI不能为空');
          }
          result = await this.getResource(params.uri as string);
          break;

        case 'prompts/list':
          result = { prompts: this.listPrompts() };
          break;

        case 'prompts/get':
          if (!params || !params.name) {
            throw new Error('提示词名称不能为空');
          }
          result = await this.getPrompt(params.name as string, (params.arguments as Record<string, unknown>) || {});
          break;

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }

      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (error) {
      RuntimeUtil.makeLog('error', `MCP JSON-RPC处理失败[${method}]: ${errMessage(error)}`, 'MCPServer');

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: errMessage(error),
        },
      };
    }
  }

  /**
   * 处理initialize请求
   */
  async handleInitialize(_params?: unknown): Promise<{
    protocolVersion: string;
    capabilities: {
      tools: Record<string, never>;
      resources: Record<string, never>;
      prompts: Record<string, never>;
    };
    serverInfo: {
      name: string;
      version: string;
    };
  }> {
    return {
      protocolVersion: this.serverInfo.protocolVersion,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: this.serverInfo.name,
        version: this.serverInfo.version,
      },
    };
  }

  /**
   * 注册跨平台通用核心工具
   */
  registerCoreTools(): void {
    // 工具1：系统信息（跨平台）
    this.registerTool('system.info', {
      description: '获取系统信息（操作系统、CPU、内存、平台等）',
      inputSchema: {
        type: 'object',
        properties: {
          detail: {
            type: 'boolean',
            description: '是否返回详细信息（默认false）',
            default: false,
          },
        },
        required: [],
      },
      handler: async (args) => {
        const { detail = false } = args;
        const memUsage = process.memoryUsage();
        const cpuInfo = os.cpus();

        const info: Record<string, unknown> = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          hostname: os.hostname(),
          cpu: {
            cores: cpuInfo.length,
            model: cpuInfo[0]?.model || 'Unknown',
          },
          memory: {
            total: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
            free: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
            used: `${Math.round((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024)}GB`,
            usage: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
          },
          uptime: {
            seconds: Math.round(os.uptime()),
            hours: Math.round(os.uptime() / 3600),
            days: Math.round(os.uptime() / 86400),
          },
        };

        if (detail) {
          info.processMemory = {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
            external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
          };
          info.networkInterfaces = Object.keys(os.networkInterfaces()).length;
        }

        return info;
      },
    });

    // 工具2：时间工具（跨平台）
    this.registerTool('time.now', {
      description: '获取当前时间信息（支持多种格式和时区）',
      inputSchema: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['iso', 'locale', 'timestamp', 'unix'],
            description: '时间格式: iso(ISO 8601), locale(本地格式), timestamp(毫秒时间戳), unix(秒时间戳)',
            default: 'locale',
          },
          timezone: {
            type: 'string',
            description: '时区（可选，例如: Asia/Shanghai, America/New_York）',
          },
        },
        required: [],
      },
      handler: async (args) => {
        const { format = 'locale', timezone } = args;
        const now = new Date();
        const options: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone as string } : {};

        switch (format) {
          case 'iso':
            return {
              format: 'iso',
              time: now.toISOString(),
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000),
            };
          case 'timestamp':
            return {
              format: 'timestamp',
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000),
              iso: now.toISOString(),
            };
          case 'unix':
            return {
              format: 'unix',
              unix: Math.floor(now.getTime() / 1000),
              timestamp: now.getTime(),
              iso: now.toISOString(),
            };
          case 'locale':
          default:
            return {
              format: 'locale',
              time: now.toLocaleString('zh-CN', options),
              date: now.toLocaleDateString('zh-CN', options),
              timeOnly: now.toLocaleTimeString('zh-CN', options),
              timestamp: now.getTime(),
              unix: Math.floor(now.getTime() / 1000),
              iso: now.toISOString(),
            };
        }
      },
    });

    // 工具3：UUID生成（跨平台）
    this.registerTool('util.uuid', {
      description: '生成UUID（通用唯一标识符）',
      inputSchema: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            enum: ['v4'],
            description: 'UUID版本: v4(随机UUID)',
            default: 'v4',
          },
          count: {
            type: 'integer',
            description: '生成数量（1-100）',
            minimum: 1,
            maximum: 100,
            default: 1,
          },
        },
        required: [],
      },
      handler: async (args) => {
        const { version = 'v4', count = 1 } = args;
        const n = Math.min(Math.max(Number(count) || 1, 1), 100);
        const uuids = Array.from({ length: n }, () => RuntimeUtil.uuid());
        return {
          version,
          count: uuids.length,
          uuids: n === 1 ? uuids[0] : uuids,
        };
      },
    });

    // 工具4：哈希计算（跨平台）
    this.registerTool('util.hash', {
      description: '计算字符串或数据的哈希值（支持多种算法）',
      inputSchema: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: '要计算哈希的数据',
          },
          algorithm: {
            type: 'string',
            enum: ['md5', 'sha1', 'sha256', 'sha512'],
            description: '哈希算法',
            default: 'sha256',
          },
        },
        required: ['data'],
      },
      handler: async (args) => {
        const { data, algorithm = 'sha256' } = args;
        if (!data) {
          throw new Error('数据不能为空');
        }

        const crypto = await import('crypto');
        const hash = crypto.createHash(algorithm as string);
        hash.update(data as string);

        return {
          algorithm,
          hash: hash.digest('hex'),
          length: hash.digest('hex').length,
        };
      },
    });
  }
}
