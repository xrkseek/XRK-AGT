import AiWorkflow from '#infrastructure/ai-workflow/ai-workflow.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import path from 'path';
import { BaseTools } from '#utils/base-tools.js';
import { InputValidator } from '#utils/input-validator.js';
import { resolveConfiguredWorkspace, ensureAgentWorkspaceSync, getConfiguredDefaultWorkspaceId } from '../lib/ai-workspace-runtime.js';
import { exec } from '#utils/exec-async.js';
import { buildRepoMapLite } from '#utils/workspace/repo-map-lite.js';
import { applyEditBlocks } from '#utils/workspace/apply-edit-blocks.js';
const IS_WINDOWS = process.platform === 'win32';

/**
 * 基础工具工作流（配置：`ai-workflow.tools.file`）
 *
 * MCP 工具面（名带 `tools.` 前缀）：
 *   read / grep / search_replace / write / delete_file / list_files / run
 *   apply_edit（aider SEARCH/REPLACE 批量）/ verify（需 runEnabled）
 *   repo_map（轻量代码地图）/ update_todos（会话待办）
 *
 * 与 chat 融合：AI 助手 `mergeWorkflows` 含 `tools` 时，工具挂入合成实例；
 * `buildSystemPrompt()` 经 `collectAuxiliaryStreamPrompts` 注入 chat system 的「可用能力」段。
 * 细则见 `.xrk/skills/core/agent-tools/SKILL.md`、`docs/mcp-guide.md`。
 */
export default class ToolsStream extends AiWorkflow {
  /** 工作区级会话待办（对齐 OpenCode todowrite / Cline plan） */
  sessionTodos = new Map();

  constructor() {
    super({
      name: 'tools',
      description: '基础工具：read/grep/search_replace/write/apply_edit/verify/delete_file/list_files/run/repo_map/update_todos',
      version: '1.0.7',
      author: 'XRK',
      priority: 200, // 高优先级，基础工具
      config: {
        enabled: true,
        temperature: 0.3,
        maxTokens: 2000,
        topP: 0.9
      }
    });

    this.workspace = ensureAgentWorkspaceSync(getConfiguredDefaultWorkspaceId());
    this.tools = new BaseTools(this.workspace);
    this.fileToolsCfg = {};
  }

  applyFileToolsConfig() {
    const fileCfg = getAiWorkflowConfigOptional().tools?.file ?? {};
    this.fileToolsCfg = {
      maxReadChars:
        typeof fileCfg.maxReadChars === 'number' && Number.isFinite(fileCfg.maxReadChars)
          ? Math.max(1000, Math.floor(fileCfg.maxReadChars))
          : 120_000,
      grepMaxResults:
        typeof fileCfg.grepMaxResults === 'number' && Number.isFinite(fileCfg.grepMaxResults)
          ? Math.min(500, Math.max(1, Math.floor(fileCfg.grepMaxResults)))
          : 80,
      // 与 schema / 默认 yaml / auth 强制 Key 一致：须显式 true 才开 shell
      runEnabled: fileCfg.runEnabled === true,
      runTimeoutMs:
        typeof fileCfg.runTimeoutMs === 'number' && Number.isFinite(fileCfg.runTimeoutMs)
          ? Math.max(1000, Math.floor(fileCfg.runTimeoutMs))
          : 120_000,
      maxCommandOutputChars:
        typeof fileCfg.maxCommandOutputChars === 'number' &&
        Number.isFinite(fileCfg.maxCommandOutputChars)
          ? Math.max(1000, Math.floor(fileCfg.maxCommandOutputChars))
          : 80_000
    };
    this.workspace = resolveConfiguredWorkspace(fileCfg.workspace);
    this.tools = new BaseTools(this.workspace);
  }

  async init() {
    this.applyFileToolsConfig();
    await super.init();
    this.registerAllFunctions();
  }

  registerAllFunctions() {
    this.registerMCPTool('read', {
      description: '读取文件内容。支持相对路径和绝对路径，文件不存在时自动在工作区搜索。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径（相对或绝对路径）'
          }
        },
        required: ['filePath']
      },
      handler: async (args = {}, context = {}) => {
        const { filePath } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };

        let result = await this.tools.readFile(filePath);
        
        if (!result.success) {
          result = await this.trySearchAndReadFile(filePath);
        }

        if (result.success) {
          const maxChars = this.fileToolsCfg.maxReadChars ?? 120_000;
          let content = result.content;
          let truncated = false;
          if (typeof content === 'string' && content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
          }
          return {
            success: true,
            data: {
              filePath: result.path,
              fileName: path.basename(result.path),
              content,
              size: result.content.length,
              returnedChars: typeof content === 'string' ? content.length : 0,
              truncated,
              maxReadChars: maxChars
            }
          };
        }
        
        return { success: false, error: result.error || `未找到文件: ${filePath}` };
      },
      enabled: true
    });

    this.registerMCPTool('grep', {
      description: '在文件中搜索文本。支持指定文件或工作区所有文件，不区分大小写。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '搜索关键词'
          },
          filePath: {
            type: 'string',
            description: '文件路径（可选，不指定则搜索所有文件）'
          }
        },
        required: ['pattern']
      },
      handler: async (args = {}, context = {}) => {
        const { pattern, filePath } = args;
        if (!pattern) return { success: false, error: '搜索关键词不能为空' };

        const result = await this.tools.grep(pattern, filePath, {
          caseSensitive: false,
          lineNumbers: true,
          maxResults: this.fileToolsCfg.grepMaxResults ?? 100
        });

        if (result.success) {
          return {
            success: true,
            data: {
              pattern,
              filePath: filePath || null,
              matches: result.matches,
              count: result.matches.length
            }
          };
        }
        
        return { success: false, error: `搜索失败: ${pattern}` };
      },
      enabled: true
    });

    this.registerMCPTool('search_replace', {
      description:
        '按 oldText 精确替换为 newText（定向改代码）。oldText 须唯一；多处相同则加长上下文或 replaceAll=true。改前先 read 确认片段。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          oldText: { type: 'string', description: '要被替换的原文（含足够上下文）' },
          newText: { type: 'string', description: '替换后的文本（可为空字符串）' },
          replaceAll: { type: 'boolean', description: '是否替换所有匹配', default: false }
        },
        required: ['filePath', 'oldText', 'newText']
      },
      handler: async (args = {}) => {
        const { filePath, oldText, newText, replaceAll = false } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        const result = await this.tools.searchReplace(filePath, oldText, newText, { replaceAll });
        if (result.success) {
          return {
            success: true,
            raw: `已替换 ${result.replacements} 处${result.replaceAll ? '（全部）' : ''}：${result.path}`,
            data: result
          };
        }
        return {
          success: false,
          error: result.error,
          data: result.occurrences ? { occurrences: result.occurrences } : undefined
        };
      },
      enabled: true
    });

    this.registerMCPTool('write', {
      description:
        '新建文件或整文件覆盖。已存在文件默认拒绝，须 overwrite=true；局部改动必须用 search_replace（对齐 OpenCode：edit 改、write 建）。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径'
          },
          content: {
            type: 'string',
            description: '文件内容'
          },
          overwrite: {
            type: 'boolean',
            description: '目标已存在时是否允许整文件覆盖（默认 false）',
            default: false
          }
        },
        required: ['filePath', 'content']
      },
      handler: async (args = {}) => {
        const { filePath, content, overwrite = false } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };
        if (content === undefined) return { success: false, error: '文件内容不能为空' };

        const result = await this.tools.writeFile(filePath, content, 'utf8', { overwrite: !!overwrite });

        if (result.success) {
          return {
            success: true,
            data: {
              filePath: result.path,
              overwritten: !!result.overwritten,
              message: result.overwritten ? '文件已整文件覆盖' : '文件写入成功'
            }
          };
        }

        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('delete_file', {
      description: '删除文件。此操作不可恢复，请谨慎使用。',
      inputSchema: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: '文件路径'
          }
        },
        required: ['filePath']
      },
      handler: async (args = {}, context = {}) => {
        const { filePath } = args;
        if (!filePath) return { success: false, error: '文件路径不能为空' };

        const fullPath = this.tools.resolvePath(filePath);
        const gate = this.tools.assertWritablePath(fullPath);
        if (!gate.ok) return { success: false, error: gate.error };
        try {
          const fs = await import('fs/promises');
          await fs.unlink(fullPath);
          return {
            success: true,
            data: {
              filePath: fullPath,
              message: '文件删除成功'
            }
          };
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      enabled: true
    });

    this.registerMCPTool('list_files', {
      description: '列出目录中的文件和子目录。支持过滤文件类型和是否包含隐藏文件，默认列出工作区。',
      inputSchema: {
        type: 'object',
        properties: {
          dirPath: {
            type: 'string',
            description: '目录路径（可选，默认为工作区）'
          },
          includeHidden: {
            type: 'boolean',
            description: '是否包含隐藏文件',
            default: false
          },
          type: {
            type: 'string',
            enum: ['all', 'files', 'dirs'],
            description: '文件类型过滤：all(全部)、files(仅文件)、dirs(仅目录)',
            default: 'all'
          }
        },
        required: []
      },
      handler: async (args = {}, context = {}) => {
        const { dirPath = null, includeHidden = false, type = 'all' } = args;
        const result = await this.tools.listDir(dirPath, { includeHidden, type });
        
        if (result.success) {
          return {
            success: true,
            data: {
              path: result.path,
              items: result.items,
              count: result.items.length
            }
          };
        }
        
        return { success: false, error: result.error };
      },
      enabled: true
    });

    this.registerMCPTool('run', {
      description:
        '在工作区目录下执行 shell 命令。Windows：CMD 或 PowerShell（Get-/Set- 等前缀走 PowerShell）；Linux/macOS：/bin/sh -lc。受 ai-workflow.tools.file.runEnabled / runTimeoutMs 约束；危险命令经 security.toolScan 拦截。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的命令'
          }
        },
        required: ['command']
      },
      handler: async (args = {}, context = {}) => {
        if (!this.fileToolsCfg.runEnabled) {
          return { success: false, error: 'run 已在 ai-workflow.tools.file.runEnabled 中关闭' };
        }

        const { command } = args;
        if (!command) {
          return { success: false, error: '命令不能为空' };
        }

        try {
          const { output, stderr } = await this.executeCommand(command);
          const maxOut = this.fileToolsCfg.maxCommandOutputChars ?? 200_000;
          let out = output;
          let truncated = false;
          if (out.length > maxOut) {
            out = out.slice(0, maxOut);
            truncated = true;
          }
          return {
            success: true,
            data: {
              command,
              output: out,
              stderr: stderr ? String(stderr).slice(0, maxOut) : '',
              message: '命令执行完成',
              truncated,
              maxCommandOutputChars: maxOut,
              platform: process.platform
            }
          };
        } catch (err) {
          return { success: false, error: err.message, stderr: err.stderr || '' };
        }
      },
      enabled: true
    });

    this.registerMCPTool('apply_edit', {
      description:
        '批量应用 aider 式 SEARCH/REPLACE 块（一次改多文件/多处）。格式：`path\\n<<<<<<< SEARCH\\n旧\\n=======\\n新\\n>>>>>>> REPLACE`。改后建议 verify。',
      inputSchema: {
        type: 'object',
        properties: {
          patch: {
            type: 'string',
            description: '含一个或多个 SEARCH/REPLACE 块的文本'
          },
          dryRun: {
            type: 'boolean',
            description: '只校验不写盘',
            default: false
          }
        },
        required: ['patch']
      },
      handler: async (args = {}) => {
        const patch = String(args.patch || '');
        if (!patch.trim()) return { success: false, error: 'patch 不能为空' };
        const result = await applyEditBlocks(this.workspace, patch, { dryRun: !!args.dryRun });
        if (result.success) {
          return {
            success: true,
            raw: `已应用 ${result.applied.length} 块${result.dryRun ? '（dryRun）' : ''}`,
            data: result
          };
        }
        return {
          success: false,
          error: result.error || '部分块失败',
          data: result
        };
      },
      enabled: true
    });

    this.registerMCPTool('verify', {
      description:
        '改码后校验闭环（aider lint/test 思路）：在工作区执行检查命令（如 pnpm test / node --check file.js）。依赖 runEnabled。',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '校验命令（默认：若未传则尝试 node --check 无意义；请显式传入）'
          }
        },
        required: ['command']
      },
      handler: async (args = {}) => {
        if (!this.fileToolsCfg.runEnabled) {
          return { success: false, error: 'verify 需要 tools.file.runEnabled=true' };
        }
        const command = String(args.command || '').trim();
        if (!command) return { success: false, error: 'command 不能为空' };
        try {
          const { output, stderr } = await this.executeCommand(command);
          const maxOut = this.fileToolsCfg.maxCommandOutputChars ?? 200_000;
          return {
            success: true,
            data: {
              command,
              ok: true,
              output: String(output || '').slice(0, maxOut),
              stderr: String(stderr || '').slice(0, maxOut)
            }
          };
        } catch (err) {
          return {
            success: false,
            error: err.message,
            data: {
              command,
              ok: false,
              stdout: err.stdout || '',
              stderr: err.stderr || ''
            }
          };
        }
      },
      enabled: true
    });

    this.registerMCPTool('repo_map', {
      description:
        '生成工作区轻量代码地图（路径 + 符号骨架，按 query 加权）。大仓定位优先于盲目 list_files；对齐 aider repo map 最小集。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '当前任务关键词（文件名/符号/主题），用于提高相关文件排序'
          },
          maxTokens: {
            type: 'number',
            description: '地图文本 token 预算（默认约 1200）'
          }
        },
        required: []
      },
      handler: async (args = {}) => {
        try {
          const map = await buildRepoMapLite(this.workspace, {
            query: args.query || '',
            maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : 1200
          });
          return {
            success: true,
            raw: map.text,
            data: { files: map.files, count: map.files.length }
          };
        } catch (err) {
          return { success: false, error: Error.isError(err) ? err.message : String(err) };
        }
      },
      enabled: true
    });

    this.registerMCPTool('update_todos', {
      description:
        '更新当前工作区会话的待办清单（多步任务时用）。传入完整 todos 数组覆盖；status: pending|in_progress|completed|cancelled。完成关键步骤后立刻更新，便于自检与续作。',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整待办列表（覆盖写入）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定 id（短英文或数字）' },
                content: { type: 'string', description: '待办内容' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: '状态'
                }
              },
              required: ['id', 'content', 'status']
            }
          }
        },
        required: ['todos']
      },
      handler: async (args = {}) => {
        const todos = Array.isArray(args.todos) ? args.todos : null;
        if (!todos) return { success: false, error: 'todos 必须为数组' };
        const normalized = [];
        for (const item of todos) {
          if (!item || typeof item !== 'object') continue;
          const id = String(item.id || '').trim();
          const content = String(item.content || '').trim();
          const status = String(item.status || 'pending').trim();
          if (!id || !content) continue;
          if (!['pending', 'in_progress', 'completed', 'cancelled'].includes(status)) {
            return { success: false, error: `非法 status: ${status}` };
          }
          normalized.push({ id, content, status });
        }
        const key = String(this.workspace || 'default');
        this.sessionTodos.set(key, normalized);
        const open = normalized.filter((t) => t.status === 'pending' || t.status === 'in_progress').length;
        const done = normalized.filter((t) => t.status === 'completed').length;
        return {
          success: true,
          raw: `待办已更新：共 ${normalized.length} 项（进行中/待办 ${open}，完成 ${done}）`,
          data: { todos: normalized, open, done }
        };
      },
      enabled: true
    });

  }

  async trySearchAndReadFile(filePath) {
    const searchResults = await this.tools.searchFiles(path.basename(filePath), {
      maxDepth: 2,
      fileExtensions: null
    });
    
    if (searchResults.length === 0) {
      return { success: false, error: `未找到文件: ${filePath}` };
    }
    
    return await this.tools.readFile(searchResults[0]);
  }

  async executeCommand(command) {
    const safeCommand = InputValidator.validateCommand(command);
    const timeout = this.fileToolsCfg.runTimeoutMs ?? 120_000;
    const fullCommand = this.buildFullCommand(safeCommand, this.workspace);
    const opts = {
      maxBuffer: 10 * 1024 * 1024,
      cwd: this.workspace,
      timeout,
      env: { ...process.env }
    };
    if (IS_WINDOWS) {
      opts.shell = 'cmd.exe';
    } else {
      opts.shell = '/bin/sh';
    }
    const { stdout, stderr } = await exec(fullCommand, opts);
    return { output: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() };
  }

  buildFullCommand(command, workspace) {
    const isPowerShellCmd = /^(Get-|Set-|New-|Remove-|Test-|Invoke-|Start-|Stop-)/i.test(command);
    if (IS_WINDOWS) {
      const ws = workspace.replace(/'/g, "''");
      return isPowerShellCmd
        ? `powershell -NoProfile -Command "Set-Location '${ws}'; ${command.replace(/"/g, '`"')}"`
        : `cd /d "${workspace}" && ${command}`;
    }
    const ws = workspace.replace(/'/g, `'\\''`);
    return `cd '${ws}' && ${command}`;
  }

  buildSystemPrompt() {
    const ws = this.workspace;
    return `【基础工具】read / grep / search_replace / write / delete_file / list_files / run / apply_edit / verify / repo_map / update_todos
工作区 cwd: ${ws}
陌生仓库先 repo_map(query=任务关键词) 再 grep/read。改已有：grep → read → search_replace；多文件/多处用 apply_edit（可 dryRun），改后 verify(command=…)。write 仅新建；已存在须 overwrite=true。
托管技能（对应 .xrk/skills）可改；主人 #skills更新 会按种子覆盖托管包。用户自建 skills/ 目录不受托管更新影响。装技能见 agent-skillhub。
多步任务用 update_todos。run / verify 默认可用（tools.file.runEnabled）；危险命令经 security.toolScan（可选 approval）。`;
  }
}


