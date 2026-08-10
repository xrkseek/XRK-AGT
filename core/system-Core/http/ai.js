import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import LLMFactory from '#factory/llm/LLMFactory.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs/promises';
import paths from '#utils/paths.js';
import { InputValidator } from '#utils/input-validator.js';
import { HttpResponse } from '#utils/http-utils.js';
import { resolveClientBaseUrl } from '#utils/client-base-url.js';
import { decodeMulterFilename } from '#utils/multipart-filename.js';
import { bannedWordsService } from '../lib/content-safety/banned-words-service.js';
import { mergeAgentWorkspaceIntoMessages } from '#utils/agent-workspace.js';
import {
  parseRequestWorkspace,
  buildAiWorkflowCfgForAgentRoot,
  applyRequestWorkspaceToStreams
} from '../lib/ai-workspace-runtime.js';
import { runWithAiConsoleContext, installMcpAuditHook } from '../lib/ai-workspace-context.js';
import { initOpenAIChatSSE, pipeOpenAIChatCompletionsStream, writeOpenAiWorkflowError } from '#utils/sse-openai.js';
import { pickPromptCacheOverrides } from '#utils/llm/prompt-cache-policy.js';
import { transformOpenAIStyleVisionMessages } from '#utils/llm/message-transform.js';
import { mergeUploadedImagesIntoMessages } from '#utils/llm/vision-content.js';
import { assembleChatLlmMessages } from '#infrastructure/ai-workflow/chat-pipeline.js';
import { runWithWorkflowRequestContext } from '#infrastructure/ai-workflow/workflow-request-context.js';
import {
  pickFirst,
  parseOptionalJson,
  toNum,
  toBool,
  trimLower,
  getDefaultProvider,
  resolveProviderFromRequest,
  extractMessageText,
  estimateTokens,
  resolveWorkflowStreams,
  buildOverridesFromBody
} from '#utils/http/ai-v3-utils.js';

function safePreview(value, { maxLen = 500 } = {}) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const s = value.replace(/\s+/g, ' ').trim();
    return s.length > maxLen ? `${s.slice(0, maxLen)}…(len=${s.length})` : s;
  }
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? `${s.slice(0, maxLen)}…(len=${s.length})` : s;
  } catch {
    return String(value);
  }
}

function redactSecrets(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (key === 'authorization' || key === 'api-key' || key === 'x-api-key') {
      out[k] = '<redacted>';
    } else {
      out[k] = safePreview(v, { maxLen: 200 });
    }
  }
  return out;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return { type: typeof tools, count: 0, names: [] };
  const names = [];
  for (const t of tools) {
    const name = t?.function?.name || t?.name || t?.id;
    if (name) names.push(String(name));
  }
  return {
    type: 'array',
    count: tools.length,
    names: names.slice(0, 12),
    namesTruncated: names.length > 12
  };
}

function summarizeV3Request(req, body, { contentType, messages, uploadedImagesCount = 0 } = {}) {
  const rawWorkflow = pickFirst(body, ['workflow']);
  const workflowType = rawWorkflow == null ? null : (Array.isArray(rawWorkflow) ? 'array' : typeof rawWorkflow);
  const workflowPreview = rawWorkflow && typeof rawWorkflow === 'object'
    ? {
        workflow: safePreview(rawWorkflow.workflow, { maxLen: 120 }),
        workflowsCount: Array.isArray(rawWorkflow.workflows) ? rawWorkflow.workflows.length : 0,
        streamsCount: Array.isArray(rawWorkflow.workflows) ? rawWorkflow.workflows.length : 0
      }
    : safePreview(rawWorkflow, { maxLen: 200 });

  const toolChoice = pickFirst(body, ['tool_choice', 'toolChoice']);
  const parallelToolCalls = pickFirst(body, ['parallel_tool_calls', 'parallelToolCalls']);
  const tools = pickFirst(body, ['tools']);

  return {
    method: req?.method,
    path: req?.path,
    ip: req?.ip,
    contentType: safePreview(contentType, { maxLen: 200 }),
    stream: Boolean(pickFirst(body, ['stream'])),
    model: safePreview(pickFirst(body, ['model']), { maxLen: 120 }),
    provider: safePreview(pickFirst(body, ['provider']), { maxLen: 120 }),
    llm: safePreview(pickFirst(body, ['llm']), { maxLen: 120 }),
    profile: safePreview(pickFirst(body, ['profile']), { maxLen: 120 }),
    temperature: toNum(pickFirst(body, ['temperature'])),
    max_tokens: toNum(pickFirst(body, ['max_tokens', 'maxTokens', 'max_completion_tokens', 'maxCompletionTokens'])),
    top_p: toNum(pickFirst(body, ['top_p', 'topP'])),
    tool_choice: safePreview(toolChoice, { maxLen: 200 }),
    parallel_tool_calls: toBool(parallelToolCalls),
    toolsSummary: summarizeTools(tools),
    workflow: { type: workflowType, preview: workflowPreview },
    messagesCount: Array.isArray(messages) ? messages.length : 0,
    uploadedImagesCount,
    headers: redactSecrets({
      'user-agent': req?.headers?.['user-agent'],
      'x-request-id': req?.headers?.['x-request-id'],
      'x-trace-id': req?.headers?.['x-trace-id'],
      authorization: req?.headers?.authorization,
      'api-key': req?.headers?.['api-key'],
      'content-length': req?.headers?.['content-length']
    })
  };
}

/**
 * OpenAI 兼容的 Chat Completions v3 接口
 *
 * 特性概览：
 * - 路径：POST /api/v3/chat/completions
 * - 支持 JSON 与 multipart/form-data（含图片上传，多模态对话）
 * - 图片约定（与 OpenAI Chat Completions 对齐）：
 *   - JSON：`content` 可为 string、OpenAI parts 数组、或 AGT `{ text, images[], replyImages[] }`
 *   - multipart：文件落盘为 `/media/{uuid}` URL；可选 `image_roles`（current|reply）对齐文件顺序
 *   - 多图：默认最多 visionMaxImages（10）张，transform 层截断并标注
 * - 非流式：直接调用各 provider 的 client.chat，返回 OpenAI 风格响应
 * - 流式：通过 client.chatStream + SSE 输出 chat.completion.chunk 事件，前端按 choices[0].delta.content 渲染
 * - 工作流/工具：仅负责把前端选择的“带 MCP 工具的工作流”转换为 streams 透传给 LLM 工厂，用于工具白名单控制
 */
async function handleChatCompletionsV3(req, res) {
  installMcpAuditHook();
  const contentType = req.headers['content-type'] || '';
  const body = req.body || {};
  let messages = Array.isArray(body.messages) ? body.messages : null;
  const uploadedImages = [];

  // 支持 multipart/form-data 格式（图片上传）
  if (contentType.includes('multipart/form-data')) {
    try {
      const bot = req.agentRuntime ?? AgentRuntime;
      const maxFileSize = runtimeConfig?.server?.limits?.fileSize || '100mb';
      const mediaDir = path.join(paths.data, 'media');
      await fs.mkdir(mediaDir, { recursive: true });
      const createUploader = req.createMultipartUploader || (() => req.multipartUpload);
      const upload = createUploader({
        fileSize: maxFileSize,
        files: 8,
        storage: multer.diskStorage({
          destination: (_req, _file, cb) => cb(null, mediaDir),
          filename: (_req, file, cb) => {
            const ext = path.extname(decodeMulterFilename(file.originalname)).slice(0, 20) || '.img';
            cb(null, `${crypto.randomUUID()}${ext}`);
          }
        }),
        fileFilter: (_req, file, cb) => {
        cb(null, String(file?.mimetype || '').startsWith('image/'));
        }
      }).any();

      try {
        await new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
      } catch (e) {
        const code = e?.code || e?.name || 'UPLOAD_ERROR';
        if (code === 'LIMIT_FILE_SIZE') {
          return HttpResponse.error(res, new Error(`图片超过大小限制（${maxFileSize}）`), 413, 'ai.v3.chat.completions');
        }
        if (code === 'LIMIT_FILE_COUNT') {
          return HttpResponse.error(res, new Error('上传图片数量超过限制'), 413, 'ai.v3.chat.completions');
        }
        return HttpResponse.error(res, new Error(`解析 multipart/form-data 失败: ${e?.message || e}`), 400, 'ai.v3.chat.completions');
      }
      const files = Array.isArray(req.files) ? req.files : [];
      const fields = req.body || {};
      
      // 解析 JSON 字段
      if (fields.messages) {
        try {
          messages = JSON.parse(fields.messages);
        } catch {
          return HttpResponse.validationError(res, 'messages 字段格式无效');
        }
      }
      
      // 解析其他字段
      if (fields.model) body.model = fields.model;
      if (fields.stream) body.stream = fields.stream === 'true';
      if (fields.apiKey) body.apiKey = fields.apiKey;
      if (fields.api_key) body.api_key = fields.api_key;
      if (fields.temperature) body.temperature = fields.temperature;
      if (fields.max_tokens) body.max_tokens = fields.max_tokens;
      if (fields.maxTokens) body.maxTokens = fields.maxTokens;
      if (fields.workspace) {
        try {
          body.workspace = JSON.parse(fields.workspace);
        } catch {
          body.workspace = fields.workspace;
        }
      }
      
      // 处理上传的图片：落盘为 /media/{uuid} URL，避免 base64 膨胀（OpenAI image_url 标准用法）
      if (files && files.length > 0) {
        const baseUrl = resolveClientBaseUrl(req, bot);
        for (const file of files) {
          const filename = file.filename || path.basename(file.path);
          uploadedImages.push(`${baseUrl}/media/${filename}`);
        }
      }
      // 可选：image_roles JSON 数组，与文件顺序对齐，取值 current|reply
      if (fields.image_roles) {
        try {
          body.image_roles = JSON.parse(fields.image_roles);
        } catch {
          body.image_roles = String(fields.image_roles)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
    } catch (e) {
      return HttpResponse.error(res, new Error(`解析 multipart/form-data 失败: ${e.message}`), 400, 'ai.v3.chat.completions');
    }
  }
  
  if (!messages || !Array.isArray(messages)) {
    return HttpResponse.validationError(res, 'messages 参数无效');
  }

  // HTTP 侧内容安全：对输入文本做违禁词检测（复用 data/bannedWords/global.json）
  const safetyCfg = runtimeConfig?.server?.contentSafety?.http || {};
  if (safetyCfg.enabled !== false && safetyCfg.checkAiInput !== false) {
    const extractTexts = (msg) => {
        const out = [];
      const c = msg?.content;
      if (typeof c === 'string') out.push(c);
      else if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
        }
      } else if (c && typeof c === 'object') {
        if (typeof c.text === 'string') out.push(c.text);
        if (typeof c.content === 'string') out.push(c.content);
      }
      return out;
    };

    for (const m of messages) {
      if (m?.role !== 'user') continue;
      for (const t of extractTexts(m)) {
        const hit = await bannedWordsService.checkText(t);
        if (hit) {
          const msg = `内容触发违禁词(${hit.type})：${hit.word}`;
          if (String(safetyCfg.action || 'reject').toLowerCase() === 'warn') {
            RuntimeUtil.makeLog('warn', msg, 'ai.v3.chat.completions');
            break;
          }
          return HttpResponse.error(res, new Error(msg), 400, 'ai.v3.chat.completions');
        }
      }
    }
  }

  RuntimeUtil.makeLog(
    'debug',
    `[v3/chat/completions] 入参摘要: ${safePreview(summarizeV3Request(req, body, { contentType, messages, uploadedImagesCount: uploadedImages.length }), { maxLen: 2000 })}`,
    'ai.v3.chat.completions'
  );
  
  // 上传图合并进末条 user（兼容 string / OpenAI parts / {text,images,replyImages}）
  if (uploadedImages.length > 0) {
    mergeUploadedImagesIntoMessages(messages, uploadedImages, {
      roles: Array.isArray(body.image_roles) ? body.image_roles : []
    });
  }
  // JSON 亦可直接带 images / replyImages（URL 或 data URL），不强制 multipart
  if (Array.isArray(body.images) || Array.isArray(body.replyImages)) {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      if (typeof last.content === 'string') {
        last.content = {
          text: last.content,
          images: Array.isArray(body.images) ? body.images : [],
          replyImages: Array.isArray(body.replyImages) ? body.replyImages : []
        };
      } else if (last.content && typeof last.content === 'object' && !Array.isArray(last.content)) {
        if (Array.isArray(body.images)) {
          last.content.images = [...(last.content.images || []), ...body.images];
        }
        if (Array.isArray(body.replyImages)) {
          last.content.replyImages = [...(last.content.replyImages || []), ...body.replyImages];
        }
      } else if (Array.isArray(last.content) && Array.isArray(body.images)) {
        for (const url of body.images) {
          last.content.push({ type: 'image_url', image_url: { url: String(url) } });
        }
      }
    }
  }

  const workspaceCtx = parseRequestWorkspace(body);
  const aiWorkflowCfgForRequest = buildAiWorkflowCfgForAgentRoot(
    getAiWorkflowConfigOptional(),
    workspaceCtx.agentRootAbs
  );
  await mergeAgentWorkspaceIntoMessages(messages, aiWorkflowCfgForRequest, 'v3');

  const streamFlag = Boolean(pickFirst(body, ['stream']));
  const provider = resolveProviderFromRequest(body);

  if (!provider) {
    return HttpResponse.error(
      res,
      new Error('未指定有效的LLM提供商：请检查 ai-workflow.yaml 的 llm.Provider 是否已配置，或在请求中传入 model/provider。'),
      400,
      'ai.v3.chat.completions'
    );
  }

  const base = LLMFactory.getProviderConfig(provider) || {};
  const llmConfig = {
    provider,
    ...base,
    promptCache: aiWorkflowCfgForRequest.llm?.promptCache
  };

  if (streamFlag && base.enableStream === false) {
    return HttpResponse.error(
      res,
      new Error(`提供商 ${provider} 的流式输出已禁用`),
      400,
      'ai.v3.chat.completions'
    );
  }

  // 工具面仅认请求体 workflow.workflows（含 remote-mcp.*）；未传 = 无中游 MCP
  const effectiveStreams = resolveWorkflowStreams(body);

  const client = LLMFactory.createClient(llmConfig);
  const overrides = buildOverridesFromBody(body);
  // hybrid：有 body.tools 时区分中游(MCP)/下游(请求)，中游 XRK 执行、下游透传客户端执行
  // execute：无 body.tools 且有声明的 workflows 时，仅中游由 XRK 执行
  // passthrough：无 body.tools 且无 workflows 时，tool_calls 透传
  const hasRequestTools = Array.isArray(body.tools) && body.tools.length > 0;
  overrides.mcpToolMode = hasRequestTools ? 'hybrid' : (effectiveStreams?.length ? 'execute' : 'passthrough');

  if (effectiveStreams?.length) {
    overrides.workflows = effectiveStreams;
  }

  Object.assign(
    overrides,
    pickPromptCacheOverrides(llmConfig, { stream: { name: effectiveStreams?.[0] || 'http-v3' } })
  );

  const llmMessages = await transformOpenAIStyleVisionMessages(messages, llmConfig);

  const fileWorkspaceAbs = workspaceCtx.fileRootAbs || workspaceCtx.agentRootAbs;
  const restoreStreamWorkspace = applyRequestWorkspaceToStreams(AiWorkflowLoader, fileWorkspaceAbs);
  const auditWorkspaceId = workspaceCtx.presetId || null;

  if (!streamFlag) {
    try {
      const chatResult = await runWithAiConsoleContext(
        { workspaceId: auditWorkspaceId },
        () => client.chat(llmMessages, overrides)
      );
      const text = typeof chatResult === 'string' ? chatResult : (chatResult?.content || '');
      const executedToolNames = Array.isArray(chatResult?.executedToolNames) ? chatResult.executedToolNames : [];

      const promptText = extractMessageText(messages);
      const promptTokens = estimateTokens(promptText);
      const completionTokens = estimateTokens(text);

      // 对外返回 model=provider
      const responseModel = llmConfig.provider || 'unknown';
      return HttpResponse.json(res, {
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text || '' },
          finish_reason: 'stop'
        }],
        // Web 工具卡片只读此字段（与 SSE metadata.mcp_tools 同形态），与 QQ 气泡文案无关
        ...(executedToolNames.length > 0 ? { mcp_tools: executedToolNames.map((name) => ({ name })) } : {}),
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        }
      });
    } finally {
      restoreStreamWorkspace();
    }
  }

  initOpenAIChatSSE(res);

  const now = Math.floor(Date.now() / 1000);
  const id = `chatcmpl_${Date.now()}`;
  const modelName = llmConfig.provider || 'unknown';

  RuntimeUtil.makeLog('info', `[v3/chat/completions] 开始流式输出: provider=${modelName}, id=${id}`, 'ai.v3.stream');

  try {
    RuntimeUtil.makeLog('info', `[v3/chat/completions] 调用client.chatStream开始`, 'ai.v3.stream');

    const totalContent = await pipeOpenAIChatCompletionsStream(res, {
      client,
      messages: llmMessages,
      overrides,
      id,
      created: now,
      model: modelName,
      usageMessages: messages,
      extractMessageText,
      estimateTokens,
      runWrapped: (run) => runWithAiConsoleContext({ workspaceId: auditWorkspaceId }, run)
    });

    RuntimeUtil.makeLog('info', `[v3/chat/completions] chatStream完成: 总长度=${totalContent.length}`, 'ai.v3.stream');
    RuntimeUtil.makeLog('info', `[v3/chat/completions] 流式输出完成`, 'ai.v3.stream');
  } catch (error) {
    RuntimeUtil.makeLog('error', `[v3/chat/completions] 流式输出错误: ${error.message}, stack=${error.stack?.substring(0, 200)}`, 'ai.v3.stream');
    writeOpenAiWorkflowError(res, { id, created: now, model: modelName, error });
  } finally {
    restoreStreamWorkspace();
    RuntimeUtil.makeLog('debug', `[v3/chat/completions] 关闭响应流`, 'ai.v3.stream');
    res.end();
  }
}

async function handleModels(req, res) {
  const llm = getAiWorkflowConfigOptional().llm || {};
  const defaultProvider = getDefaultProvider();
  const format = (req.query.format || '').toLowerCase();
  const profiles = LLMFactory.listModelProfiles();

  if (format === 'openai' || req.path === '/api/v3/models') {
    const list = profiles.map((p) => p.key);
    const now = Math.floor(Date.now() / 1000);
    return HttpResponse.json(res, {
      object: 'list',
      data: (list.length ? list : (defaultProvider ? [defaultProvider] : [])).map((p) => ({
        id: p,
        object: 'model',
        created: now,
        owned_by: 'xrk-agt'
      }))
    });
  }

  const vendors = LLMFactory.listVendors(profiles);

  const workflows = AiWorkflowLoader.getWorkflowsByPriority()
    .filter(s => !s.primaryStream && !s.secondaryStreams && (s.mcpTools?.size || 0) > 0)
    .map(s => ({
      key: s.name,
      label: s.description || s.name,
      description: s.description || '',
      profile: null,
      persona: null,
      uiHidden: false
    }));

  // 远程 MCP 与普通 workflow 同等：仅勾选/请求体传入时生效
  const remoteServers = AiWorkflowLoader.listRemoteMCPServers?.() || [];
  const remoteWorkflows = remoteServers.map((name) => ({
    key: `remote-mcp.${name}`,
    label: `远程 MCP：${name}`,
    description: `远程 MCP 服务器 ${name}`,
    profile: null,
    persona: null,
    uiHidden: false
  }));

  return HttpResponse.success(res, {
    enabled: llm.enabled !== false,
    defaultProfile: defaultProvider,
    defaultWorkflow: null,
    persona: llm.persona || '',
    profiles,
    vendors,
    workflows: [...workflows, ...remoteWorkflows]
  });
}

export default {
  name: 'ai-workflow',
  dsc: 'AI 工作流（含 SSE 流式输出）',
  priority: 80,
  routes: [
    {
      method: 'POST',
      path: '/api/v3/chat/completions',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        return handleChatCompletionsV3(req, res);
      }, 'ai.v3.chat.completions')
    },
    {
      method: 'GET',
      path: '/api/v3/models',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        return handleModels(req, res);
      }, 'ai.v3.models')
    },
    {
      method: 'GET',
      path: '/api/ai/models',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        return handleModels(req, res);
      }, 'ai.models')
    },
    {
      method: 'GET',
      path: '/api/ai/stream',
      handler: async (req, res) => {
        try {
          const prompt = InputValidator.sanitizeText((req.query.prompt || '').toString(), 10000);
          if (!prompt.trim()) {
            return HttpResponse.validationError(res, '缺少 prompt 参数');
          }

          const persona = (req.query.persona || '').toString();
          const workflowName = trimLower(req.query.workflow) || 'chat';
          const profileKey = trimLower(req.query.profile || req.query.llm) || undefined;
          const queryProvider = trimLower(req.query.provider) || undefined;
          const queryModel = trimLower(req.query.model) || undefined;
          const contextObj = parseOptionalJson(req.query.context);
          const metadata = parseOptionalJson(req.query.meta);

          const stream = AiWorkflowLoader.getWorkflow(workflowName) || AiWorkflowLoader.getWorkflow('chat');
          if (!stream) {
            return HttpResponse.error(res, new Error('工作流未加载'), 500, 'ai.stream');
          }

          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders?.();

          const messages = await assembleChatLlmMessages(stream, null, {
            text: prompt,
            persona,
            context: contextObj,
            metadata
          });

          const llmOverrides = {
            ...stream.config,
            workflow: workflowName,
            persona,
            profile: profileKey
          };

          // 对外接口约定：query.model 通常填 provider；query.provider 仅作为可选字段
          if (queryModel && LLMFactory.hasProvider(queryModel)) {
            llmOverrides.provider = queryModel;
          } else if (queryProvider && LLMFactory.hasProvider(queryProvider)) {
            llmOverrides.provider = queryProvider;
          } else if (profileKey && LLMFactory.hasProvider(profileKey)) {
            llmOverrides.provider = profileKey;
          }

          const executionContext = {
            e: null,
            question: {
              text: prompt,
              persona,
              context: contextObj,
              metadata
            },
            config: llmOverrides
          };

          let acc = '';
          const finalText = await runWithWorkflowRequestContext(
            { e: null, turnState: null },
            () => stream.callAiWorkflow(
              messages,
              llmOverrides,
              (delta) => {
                acc += delta;
                res.write(`data: ${JSON.stringify({ delta, workflow: stream.name })}\n\n`);
              },
              { context: executionContext }
            )
          );

          res.write(
            `data: ${JSON.stringify({
              done: true,
              workflow: stream.name,
              text: finalText || acc
            })}\n\n`
          );
          res.end();
        } catch (e) {
          errorHandler.handle(e, { context: 'ai.stream', code: ErrorCodes.SYSTEM_ERROR });
          try {
            res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
          } catch {}
          res.end();
        }
      }
    }
  ]
};