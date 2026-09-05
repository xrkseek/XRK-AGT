// @ts-nocheck
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { filterToolsByPolicy } from '#utils/runtime-policy.js';
import { previewToolCallArguments } from '#utils/llm/parse-tool-arguments.js';

/**
 * MCP 工具适配器
 *
 * 职责边界：
 * - 将 AiWorkflowLoader 暴露的 MCP 工具转为 OpenAI tools 形态，供 harness ToolRegistry 注册
 * - 在 harness 工具执行时调用 MCP，并返回 role=tool 的消息列表
 * - 基于 workflows/allowedTools 做工具白名单过滤：保证"未通过接口声明的工具"不会被调用
 * - 安全/策略门禁在 MCPServer.handleToolCall 统一执行（覆盖 LLM / HTTP / WS / JSON-RPC）
 */
export class MCPToolAdapter {
  /**
   * 获取 MCP 服务器实例
   * @returns {*}
   */
  static getMCPServer() {
    return AiWorkflowLoader.mcpServer;
  }

  /**
   * 将 MCP 工具转换为 OpenAI 格式的 tools 数组
   *
   * 说明：
   * - workflows 白名单优先：只有在 workflows 中声明的工作流，其下工具才会被注入
   * - workflow 为单工作流名，仅在未显式提供 workflows 时使用
   * - 未指定 workflow 且未指定 workflows 时不注入任何 MCP 工具（不选则不传）
   *
   * @param {Object} options
   * @param {string|null} options.workflow - 单个工作流名称；若提供则仅注入该工作流下的工具
   * @param {Array<string>} [options.workflows] - 白名单工作流列表；优先级高于 workflow
   * @returns {Array} OpenAI tools
   */
  static listMcpTools(options = {}) {
    const { workflow = null, workflows = null } = options || {};

    const mcpServer = this.getMCPServer();
    if (!mcpServer) return [];

    if (Array.isArray(workflows) && workflows.length > 0) {
      const uniq = new Map();
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

  static convertMCPToolsToOpenAI(options = {}) {
    const tools = filterToolsByPolicy(
      this.listMcpTools(options).map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: this.convertSchemaToOpenAI(tool.inputSchema || {})
        }
      }))
    );
    return tools;
  }

  /**
   * 将 JSON Schema 转换为 OpenAI function.parameters 定义
   * @param {Object} schema - JSON Schema
   * @returns {Object} OpenAI schema
   */
  static convertSchemaToOpenAI(schema) {
    if (!schema || typeof schema !== 'object') {
      return { type: 'object', properties: {}, required: [] };
    }

    const result = {
      type: schema.type || 'object',
      properties: {},
      required: schema.required || []
    };

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        result.properties[key] = {
          type: prop.type || 'string',
          description: prop.description || ''
        };

        if (prop.enum) result.properties[key].enum = prop.enum;
        if (prop.default !== undefined) result.properties[key].default = prop.default;

        // 处理 array 类型：必须包含 items 字段
        if (prop.type === 'array') {
          result.properties[key].items = prop.items || { type: 'string' };
        }

        // 处理 object 类型：可能包含 properties
        if (prop.type === 'object' && prop.properties) {
          result.properties[key].properties = prop.properties;
        }
      }
    }

    return result;
  }

  /**
   * 处理 tool_calls：并行调用 MCP 工具并返回 tool 角色消息
   *
   * 权限控制策略：
   * - 若传入 options.allowedTools，则仅允许显式列出的工具被调用
   * - 否则，若传入 options.workflows，则基于 streams 计算允许的 MCP 工具白名单
   * - /v1 + body.tools（无 workflows）走工厂单次补全，tool_calls 透传客户端，不进入本方法
   * - MCP 多轮执行在 harness module loop（经本方法）
   *
   * @param {Array} toolCalls - OpenAI tool_calls
   * @param {Object} options - 选项
   * @param {Array<string>} options.allowedTools - 允许的工具名称列表
   * @param {Array<string>} options.workflows - 允许的工作流列表（用于计算 MCP 白名单）
   * @returns {Promise<Array>} tool role messages
   */
  static async handleToolCalls(toolCalls, options = {}) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    const mcpServer = this.getMCPServer();
    if (!mcpServer) {
      return toolCalls.map(tc => ({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function?.name || 'unknown',
        content: JSON.stringify({
          success: false,
          error: 'MCP服务未启用'
        })
      }));
    }

    let allowedToolNames = null;
    if (options.allowedTools && Array.isArray(options.allowedTools)) {
      allowedToolNames = new Set(options.allowedTools);
    } else if (options.workflows && Array.isArray(options.workflows)) {
      const allowedTools = this.convertMCPToolsToOpenAI({ workflows: options.workflows });
      allowedToolNames = new Set(allowedTools.map(t => t.function.name));
    }

    const parallel = options.parallel_tool_calls ?? options.parallelToolCalls;
    const sequential = parallel === false || options.sequentialToolCalls === true;

    const runOne = async (toolCall, index) => {
      try {
        const functionName = toolCall.function?.name;

        if (allowedToolNames && !allowedToolNames.has(functionName)) {
          RuntimeUtil.makeLog(
            'warn',
            `MCP 工具调用被拒绝（不在白名单）: ${functionName}`,
            'MCPToolAdapter'
          );
          return {
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName || 'unknown',
            content: JSON.stringify({
              success: false,
              error: `工具 "${functionName}" 不在允许的工具列表中`
            })
          };
        }

        const rawArgs = toolCall.function?.arguments;
        RuntimeUtil.makeLog(
          'info',
          `MCP 工具调用开始: #${index + 1} name=${functionName}, args=${previewToolCallArguments(rawArgs)}`,
          'MCPToolAdapter'
        );

        // 参数解析 / 安全门禁统一在 MCPServer.handleToolCall
        const result = await mcpServer.handleToolCall({
          name: functionName,
          arguments: rawArgs
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
          'MCPToolAdapter'
        );

        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName || 'unknown',
          content
        };
      } catch (error) {
        const functionName = toolCall.function?.name || 'unknown';
        return {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: JSON.stringify({
            success: false,
            error: error.message || String(error)
          })
        };
      }
    };

    if (sequential) {
      const results = [];
      for (let i = 0; i < toolCalls.length; i++) {
        results.push(await runOne(toolCalls[i], i));
      }
      return results;
    }

    return Promise.all(toolCalls.map((tc, i) => runOne(tc, i)));
  }

  /**
   * 是否有可用 MCP 工具
   * @returns {boolean}
   */
  static hasTools() {
    const mcpServer = this.getMCPServer();
    return Boolean(mcpServer && mcpServer.tools && mcpServer.tools.size > 0);
  }
}

