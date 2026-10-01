import path from 'node:path';
import fs from 'node:fs/promises';
// @ts-expect-error no @types/multer
import multer from 'multer';
import runtimeConfig from '#infrastructure/config/config.js';
import { HttpResponse } from '#utils/http-utils.js';
import { decodeMulterFilename } from '#utils/multipart-filename.js';
import { resolveClientBaseUrl } from '#utils/client-base-url.js';
import {
  normalizePresetId,
  getConfiguredDefaultWorkspaceId,
  listWorkspacePresets,
  listPresetFiles,
  listWorkspaceFiles,
  readPresetAgents,
  writePresetAgents,
  resolvePresetDownload,
  resolvePresetOrThrow,
  parseRequestWorkspace,
  createAgentWorkspace,
  sanitizeWorkspaceUploadName,
  openWorkspaceFileDownload
} from '../lib/ai-workspace-runtime.js';
import { readAuditTail } from '../lib/ai-workspace-audit.js';
import { installMcpAuditHook } from '../lib/ai-workspace-context.js';
import { buildConsoleLlmCatalog } from '../lib/ai-gateway/models.js';

function ensureAuditHook() {
  installMcpAuditHook();
}

function parsePresetId(req: any) {
  const raw = req.query.workspace ?? req.query.id ?? req.body?.workspace ?? getConfiguredDefaultWorkspaceId();
  return normalizePresetId(String(raw ?? '').trim() || getConfiguredDefaultWorkspaceId());
}

function createWorkspaceUploader(req: any, destDir: any, maxFileSize: any) {
  const createUploader = req.createMultipartUploader || (() => req.multipartUpload);
  const storage = multer.diskStorage({
    destination: ($_1: any, $_2: any, cb: any) => cb(null, destDir),
    filename: (_req: any, file: any, cb: any) => {
      const safe = sanitizeWorkspaceUploadName(decodeMulterFilename(file.originalname));
      cb(null, safe);
    }
  });
  return createUploader({
    storage,
    fileSize: maxFileSize,
    files: 8
  }).any();
}

export default {
  name: 'ai-workspace',
  dsc: 'AI 对话工作区：预设、文件、规则、审计',
  priority: 79,

  routes: [
    {
      method: 'GET',
      path: '/api/ai/models',
      systemAuth: 'ai.models.catalog',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        ensureAuditHook();
        return HttpResponse.success(res, buildConsoleLlmCatalog());
      }, 'ai.models.catalog')
    },
    {
      method: 'GET',
      path: '/api/ai/workspaces',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        ensureAuditHook();
        const presets = listWorkspacePresets().map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          kind: p.kind
        }));
        HttpResponse.success(res, { workspaces: presets, defaultId: getConfiguredDefaultWorkspaceId() });
      }, 'ai.workspaces.list')
    },
    {
      method: 'POST',
      path: '/api/ai/workspaces',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const id = String(req.body?.id || req.body?.name || '').trim();
        if (!id) return HttpResponse.validationError(res, 'id 不能为空');
        try {
          const created = createAgentWorkspace(id);
          HttpResponse.success(res, created, '工作区已创建');
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '创建失败');
        }
      }, 'ai.workspaces.create')
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const subdir = String(req.query.dir ?? '').trim();
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 120));
        try {
          const result = await listPresetFiles(workspace, { subdir, limit });
          HttpResponse.success(res, {
            workspace,
            root: result.root,
            dir: result.dir,
            files: result.files,
            ...((result as any).error ? { hint: (result as any).error } : {})
          });
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '无效工作区');
        }
      }, 'ai.workspace.files')
    },
    {
      method: 'POST',
      path: '/api/ai/workspace/files/upload',
      handler: HttpResponse.asyncHandler(async (req: any, res: any, AgentRuntime: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const subdir = String(req.query.dir ?? req.body?.dir ?? '').trim();
        const ctx = parseRequestWorkspace({ workspace: { id: workspace } });
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          return HttpResponse.validationError(res, '请使用 multipart/form-data 上传');
        }
        const maxFileSize = runtimeConfig?.server?.limits?.fileSize || '100mb';
        let destDir;
        try {
          const listed = listWorkspaceFiles(ctx.fileRootAbs, subdir);
          destDir = path.resolve(ctx.fileRootAbs, listed.dir || '.');
          await fs.mkdir(destDir, { recursive: true });
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '无效目录');
        }
        let files: any[] = [];
        try {
          const upload = createWorkspaceUploader(req, destDir, maxFileSize);
          await new Promise<void>((resolve, reject) => upload(req, res, (err: any) => (err ? reject(err) : resolve())));
          files = Array.isArray(req.files) ? req.files : [];
        } catch (e: any) {
          return HttpResponse.error(res, new Error(e?.message || '上传失败'), 400, 'ai.workspace.upload');
        }
        if (!files.length) return HttpResponse.validationError(res, '没有文件');
        const baseUrl = resolveClientBaseUrl(req, AgentRuntime);
        const relDir = String(subdir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const uploaded = files.map((f) => {
          const name = path.basename(f.filename || f.originalname || 'file');
          const relPath = relDir ? `${relDir}/${name}` : name;
          const serveUrl = `${baseUrl}/api/ai/workspace/files/serve?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(relPath)}`;
          return { name, path: relPath, size: f.size, url: serveUrl };
        });
        HttpResponse.success(res, { workspace, dir: relDir, files: uploaded }, '上传成功');
      }, 'ai.workspace.upload')
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files/serve',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const filePath = String(req.query.path || '').trim();
        if (!filePath) return HttpResponse.validationError(res, 'path 不能为空');
        const ctx = parseRequestWorkspace({ workspace: { id: workspace } });
        try {
          const { abs, name } = openWorkspaceFileDownload(ctx.fileRootAbs, filePath);
          res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(name)}"`);
          return res.sendFile(abs);
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '无法读取文件');
        }
      }, 'ai.workspace.serve')
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/files/download',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const filePath = String(req.query.path || '').trim();
        if (!filePath) return HttpResponse.validationError(res, 'path 不能为空');
        try {
          const { abs, basename } = await resolvePresetDownload(workspace, filePath);
          return res.download(abs, basename);
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '无法下载');
        }
      }, 'ai.workspace.download')
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/agents',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        try {
          resolvePresetOrThrow(workspace);
          const data = await readPresetAgents(workspace);
          HttpResponse.success(res, { workspace, ...data });
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '读取失败');
        }
      }, 'ai.workspace.agents.get')
    },
    {
      method: 'PUT',
      path: '/api/ai/workspace/agents',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        const content = req.body?.content;
        if (typeof content !== 'string') {
          return HttpResponse.validationError(res, 'content 必须为字符串');
        }
        try {
          const saved = await writePresetAgents(workspace, content);
          HttpResponse.success(res, { workspace, ...saved }, '规则已保存');
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '保存失败');
        }
      }, 'ai.workspace.agents.put')
    },
    {
      method: 'GET',
      path: '/api/ai/workspace/audit',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        ensureAuditHook();
        const workspace = parsePresetId(req);
        try {
          resolvePresetOrThrow(workspace);
          const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
          const entries = await readAuditTail(workspace, limit);
          HttpResponse.success(res, { workspace, entries });
        } catch (err: any) {
          return HttpResponse.validationError(res, err.message || '无效工作区');
        }
      }, 'ai.workspace.audit')
    }
  ]
};
