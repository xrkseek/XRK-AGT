import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { filterToolsByPolicy } from '#utils/runtime-policy.js';
import { previewToolCallArguments } from '#utils/llm/parse-tool-arguments.js';
import { normalizeError } from '#utils/normalize-error.js';

/**
 * MCP 工具适配器
 *
 * 职责边界：
 * - 将 AiWorkflowLoader 暴露的 MCP 工具转为 OpenAI tools 形态，供 harness ToolRegistry 注册
 * - 在 harness 工具执行时调用 MCP，并返回 role=tool 的消息列表
 * - 基于 workflows/allowedTools 做工具白名单过滤：保证"未通过接口声明的工具"不会被调用
 * - 安全/策略门禁在 MCPServer.handleToolCall 统一执行（覆盖 LLM / HTTP / WS / JSON-RPC）
 * - **边界**：不迁执行到 harness `createMcpClient`；远程 MCP 仍先挂本仓 MCPServer（见 ADR-0002 · harness-module-loop.md「MCP 执行边界」）
 * @see .cursor/skills/xrk-v3-api/SKILL.md — /v1 + body.tools（无 workflows）不进入 handleToolCalls
 */

type JsonSchemaProp = {
  type?: string;
  description?: string;
  enum?: unknown;
  default?: unknown;
  items?: unknown;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  [key: string]: unknown;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type ToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type ToolRoleMessage = {
  role: 'tool';
  tool_call_id: string | undefined;
  name: string;
  content: string;
};

type ListToolsOptions = {
  workflow?: string | null;
  workflows?: string[] | null;
};

type HandleToolCallsOptions = ListToolsOptions & {
  allowedTools?: string[];
  parallel_tool_calls?: boolean;
  parallelToolCalls?: boolean;
  sequentialToolCalls?: boolean;
};

type McpServerLike = {
  listTools: (workflow?: string | null) => McpTool[];
  handleToolCall: (req: { name?: string; arguments?: unknown }) => Promise<{
    content?: Array<{ text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  }>;
  tools?: { size?: number };
};

export class MCPToolAdapter {
  static getMCPServer(): McpServerLike | null | undefined {
    return (AiWorkflowLoader as { mcpServer?: McpServerLike | null }).mcpServer;
  }

  /**
   * 将 MCP 工具转换为 OpenAI 格式的 tools 数组
   *
   * - workflows 白名单优先
   * - workflow 为单工作流名，仅在未显式提供 workflows 时使用
   * - 未指定 workflow 且未指定 workflows 时不注入任何 MCP 工具
   */
  static listMcpTools(options: ListToolsOptions = {}): McpTool[] {
    const { workflow = null, workflows = null } = options || {};

    const mcpServer = this.getMCPServer();
    if (!mcpServer) return [];

    if (Array.isArray(workflows) && workflows.length > 0) {
      const uniq = new Map<string, McpTool>();
      for (const s of workflows.filter(Boolean)) {
        for (const tool of mcpServer.listTools(s)) {
          if (!uniq.has(tool.name)) uniq.set(tool.name, tool);
        }
      }
      return Array.from(uniq.values());
    }
    if (workflow) {
      return mcpServer.listTools(workflow);
    }
    return [];
  }

  static convertMCPToolsToOpenAI(options: ListToolsOptions = {}): OpenAITool[] {
    const tools = filterToolsByPolicy(
      this.listMcpTools(options).map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: this.convertSchemaToOpenAI(tool.inputSchema || {}),
        },
      })),
    );
    return tools as OpenAITool[];
  }

  static convertSchemaToOpenAI(schema: JsonSchema | null | undefined): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {}, required: [] };
    }

    const result: Record<string, unknown> = {
      type: schema.type || 'object',
      properties: {} as Record<string, Record<string, unknown>>,
      required: schema.required || [],
    };

    const properties = result.properties as Record<string, Record<string, unknown>>;

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const p = prop || {};
        properties[key] = {
          type: p.type || 'string',
          description: p.description || '',
        };

        if (p.enum) properties[key]!.enum = p.enum;
        if (p.default !== undefined) properties[key]!.default = p.default;

        if (p.type === 'array') {
          properties[key]!.items = p.items || { type: 'string' };
        }

        if (p.type === 'object' && p.properties) {
          properties[key]!.properties = p.properties;
        }
      }
    }

    return result;
  }

  /**
   * 处理 tool_calls：并行调用 MCP 工具并返回 tool 角色消息
   *
   * - 若传入 options.allowedTools，则仅允许显式列出的工具被调用
   * - 否则，若传入 options.workflows，则基于 streams 计算允许的 MCP 工具白名单
   * - /v1 + body.tools（无 workflows）走工厂单次补全，tool_calls 透传客户端，不进入本方法
   */
  static async handleToolCalls(
    toolCalls: ToolCall[] | null | undefined,
    options: HandleToolCallsOptions = {},
  ): Promise<ToolRoleMessage[]> {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    const mcpServer = this.getMCPServer();
    if (!mcpServer) {
      return toolCalls.map((tc) => ({
        role: 'tool' as const,
        tool_call_id: tc.id,
        name: tc.function?.name || 'unknown',
        content: JSON.stringify({
          success: false,
          error: 'MCP服务未启用',
        }),
      }));
    }

    let allowedToolNames: Set<string> | null = null;
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      allowedToolNames = new Set(options.allowedTools);
    } else if (options.workflows && Array.isArray(options.workflows)) {
      const allowedTools = this.convertMCPToolsToOpenAI({ workflows: options.workflows });
      allowedToolNames = new Set(
        allowedTools.map((t) => t.function?.name).filter((n): n is string => Boolean(n)),
      );
    }

    const parallel = options.parallel_tool_calls ?? options.parallelToolCalls;
    const sequential = parallel === false || options.sequentialToolCalls === true;

    const runOne = async (toolCall: ToolCall, index: number): Promise<ToolRoleMessage> => {
      try {
        const functionName = toolCall.function?.name;

        if (allowedToolNames && functionName && !allowedToolNames.has(functionName)) {
          RuntimeUtil.makeLog(
            'warn',
            `MCP 工具调用被拒绝（不在白名单）: ${functionName}`,
            'MCPToolAdapter',
          );
          return {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName || 'unknown',
            content: JSON.stringify({
              success: false,
              error: `工具 "${functionName}" 不在允许的工具列表中`,
            }),
          };
        }

        const rawArgs = toolCall.function?.arguments;
        RuntimeUtil.makeLog(
          'info',
          `MCP 工具调用开始: #${index + 1} name=${functionName}, args=${previewToolCallArguments(rawArgs)}`,
          'MCPToolAdapter',
        );

        const result = await mcpServer.handleToolCall({
          name: functionName,
          arguments: rawArgs,
        });

        let content = result?.content?.[0]?.text;
        if (typeof content !== 'string' || !content.length) {
          try {
            const fallback = result !== undefined && result !== null ? result : { success: true };
            content = JSON.stringify(fallback);
          } catch {
            content = '{"success":false,"error":"MCPToolAdapter: 无法序列化工具返回值"}';
          }
        }

        RuntimeUtil.makeLog(
          'info',
          `MCP 工具调用完成: #${index + 1} name=${functionName}, isError=${Boolean(result.isError)}`,
          'MCPToolAdapter',
        );

        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName || 'unknown',
          content,
        };
      } catch (error: unknown) {
        const functionName = toolCall.function?.name || 'unknown';
        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: JSON.stringify({
            success: false,
            error: normalizeError(error).message || String(error),
          }),
        };
      }
    };

    if (sequential) {
      const results: ToolRoleMessage[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        results.push(await runOne(toolCalls[i]!, i));
      }
      return results;
    }

    return Promise.all(toolCalls.map((tc, i) => runOne(tc, i)));
  }

  static hasTools(): boolean {
    const mcpServer = this.getMCPServer();
    return Boolean(mcpServer && mcpServer.tools && (mcpServer.tools.size ?? 0) > 0);
  }
}
