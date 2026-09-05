// @ts-nocheck
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import paths from '#utils/paths.js';
import RuntimeUtil from '#utils/runtime-util.js';
import { errorHandler, ErrorCodes } from '#utils/error-handler.js';
import { InputValidator } from '#utils/input-validator.js';
import { HttpResponse } from '#utils/http-utils.js';
import { decodeMulterFilename } from '#utils/multipart-filename.js';
import { resolveClientBaseUrl } from '#utils/client-base-url.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { bannedWordsService } from '../lib/content-safety/banned-words-service.js';
import { Disposables } from '#utils/disposables.js';


const uploadDir = path.join(paths.data, 'uploads');
const mediaDir = path.join(paths.data, 'media');
const fileMap = new Map();
let __runtime = null;

async function hashFileMd5(filePath) {
  const hash = crypto.createHash('md5');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function createDiskUploader(req, maxFileSize) {
  const createUploader = req.createMultipartUploader || (() => req.multipartUpload);
  const storage = multer.diskStorage({
    destination: async (_req, file, cb) => {
      try {
        const name = decodeMulterFilename(file.originalname);
        const ext = path.extname(name);
        const isMedia = /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|mp3|wav|ogg)$/i.test(ext);
        const targetDir = isMedia ? mediaDir : uploadDir;
        await fs.mkdir(targetDir, { recursive: true });
        cb(null, targetDir);
      } catch (e) {
        cb(e);
      }
    },
    filename: (_req, file, cb) => {
      const id = crypto.randomUUID();
      const ext = path.extname(decodeMulterFilename(file.originalname)).slice(0, 20) || '.file';
      cb(null, `${id}${ext}`);
    }
  });
  return createUploader({
    storage,
    fileSize: maxFileSize,
    files: 8
  }).any();
}

// 目录已在 paths.ensureBaseDirs() 中创建，无需重复创建

/**
 * 文件管理API
 * 提供文件上传、下载、预览等功能
 */
export default {
  name: 'file',
  dsc: '文件管理API',
  priority: 95,

  routes: [
    {
      method: 'POST',
      path: '/api/file/upload',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) return HttpResponse.validationError(res, '请使用 multipart/form-data 格式上传文件');
        const maxFileSize = runtimeConfig?.server?.limits?.fileSize || '100mb';
        let files = [];
        try {
          const upload = createDiskUploader(req, maxFileSize);
          await new Promise((resolve, reject) => upload(req, res, (err) => (err ? reject(err) : resolve())));
          files = Array.isArray(req.files) ? req.files : [];
        } catch (e) {
          const code = e?.code || e?.name || 'UPLOAD_ERROR';
          if (code === 'LIMIT_FILE_SIZE') {
            return HttpResponse.error(res, new Error(`文件超过大小限制（${maxFileSize}）`), 413, 'file.upload');
          }
          if (code === 'LIMIT_FILE_COUNT') {
            return HttpResponse.error(res, new Error('上传文件数量超过限制'), 413, 'file.upload');
          }
          return HttpResponse.error(res, new Error(`解析 multipart/form-data 失败: ${e?.message || e}`), 400, 'file.upload');
        }
        if (!files?.length) return HttpResponse.validationError(res, '没有文件或文件被过滤');
        const filesWithMd5 = [];
        for (const f of files) {
          if (!f?.path) continue;
          let md5 = null;
          try {
            md5 = await hashFileMd5(f.path);
          } catch {}
          const originalname = decodeMulterFilename(f.originalname);
          filesWithMd5.push({
            id: path.basename(f.filename || '').split('.')[0],
            originalname,
            mimetype: f.mimetype,
            size: f.size,
            filename: f.filename,
            path: f.path,
            md5
          });
        }
        const safetyCfg = runtimeConfig?.server?.contentSafety?.http || {};
        if (safetyCfg.enabled !== false && safetyCfg.checkUploadMd5 !== false) {
          for (const f of filesWithMd5) {
            const hit = f.md5 ? await bannedWordsService.checkImageMd5(f.md5) : null;
            if (!hit) continue;
            const msg = `上传内容命中违禁图片(hash)：${hit.md5}`;
            if (String(safetyCfg.action || 'reject').toLowerCase() === 'warn') {
              RuntimeUtil.makeLog('warn', msg, 'file.upload');
              break;
            }
            for (const g of filesWithMd5) {
              try { await fs.unlink(g.path); } catch {}
            }
            return HttpResponse.error(res, new Error(msg), 400, 'file.upload');
          }
        }

        const uploadedFiles = [];
        const baseUrl = resolveClientBaseUrl(req, AgentRuntime);
        for (const file of filesWithMd5) {
          const ext = path.extname(file.originalname) || '.file';
          const isMedia = /\.(jpg|jpeg|png|gif|webp|bmp|svg|mp4|webm|mp3|wav|ogg)$/i.test(ext);
          const filename = file.filename || `${file.id}${ext}`;
          const targetDir = isMedia ? mediaDir : uploadDir;
          const safePath = InputValidator.validatePath(file.path, targetDir);
          const fileInfo = {
            id: file.id,
            name: file.originalname,
            path: safePath,
            url: `${baseUrl}/${isMedia ? 'media' : 'uploads'}/${filename}`,
            download_url: `${baseUrl}/api/file/${file.id}?download=true`,
            preview_url: isMedia ? `${baseUrl}/api/file/${file.id}` : null,
            size: file.size,
            mime: file.mimetype,
            hash: file.md5 || null,
            is_media: isMedia,
            upload_time: Date.now()
          };
          fileMap.set(file.id, fileInfo);
          uploadedFiles.push(fileInfo);
        }

        const results = uploadedFiles.map(f => ({
          type: f.is_media ? 'image' : 'file',
          data: [{ type: f.is_media ? 'image' : 'file', url: f.url, name: f.name, size: f.size, mime: f.mime, download_url: f.download_url, preview_url: f.preview_url }]
        }));
        const payload = {
          files: uploadedFiles.map(f => ({ file_id: f.id, file_url: f.url, file_name: f.name })),
          results,
          timestamp: Date.now()
        };
        if (uploadedFiles.length === 1) Object.assign(payload, { file_id: uploadedFiles[0].id, file_url: uploadedFiles[0].url, file_name: uploadedFiles[0].name });
        HttpResponse.success(res, payload);
      }, 'file.upload')
    },

    {
      method: 'GET',
      path: '/api/file/:id',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        // 输入验证
        const { id } = req.params;
        if (!id || typeof id !== 'string' || id.length > 50) {
          return HttpResponse.validationError(res, '无效的文件ID');
        }
        
        const { download } = req.query;
        const fileInfo = fileMap.get(id);

        if (!fileInfo) {
          try {
            for (const dir of [uploadDir, mediaDir]) {
              const files = await fs.readdir(dir);
              const file = files.find(f => f.includes(id));
              if (file) {
                // validatePath 已返回落在 dir 内的绝对路径，勿再 path.join(dir, …)
                const filePath = InputValidator.validatePath(file, dir);
                
                if (download === 'true') {
                  return res.download(filePath, file);
                }
                const ext = path.extname(filePath).toLowerCase();
                const mime = ext === '.png' ? 'image/png'
                  : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
                  : ext === '.gif' ? 'image/gif'
                  : ext === '.webp' ? 'image/webp'
                  : ext === '.svg' ? 'image/svg+xml'
                  : ext === '.bmp' ? 'image/bmp'
                  : 'application/octet-stream';
                res.setHeader('Content-Type', mime);
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.sendFile(filePath);
              }
            }
          } catch (err) {
            // debug: 文件查找失败是技术细节
            RuntimeUtil.makeLog('debug', `查找文件失败: ${err.message}`, 'FileAPI');
          }
          
          return HttpResponse.notFound(res, '文件不存在');
        }

        const safePath = InputValidator.validatePath(
          fileInfo.path,
          fileInfo.is_media ? mediaDir : uploadDir,
        );
        await fs.access(safePath);
        if (download === 'true') res.download(safePath, fileInfo.name);
        else {
          res.setHeader('Content-Type', fileInfo.mime);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.sendFile(safePath);
        }
      }, 'file.get')
    },

    {
      method: 'DELETE',
      path: '/api/file/:id',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { id } = req.params;
        if (!id || typeof id !== 'string' || id.length > 50) {
          return HttpResponse.validationError(res, '无效的文件ID');
        }
        
        const fileInfo = fileMap.get(id);

        if (fileInfo) {
          try {
            const safePath = InputValidator.validatePath(
              fileInfo.path,
              fileInfo.is_media ? mediaDir : uploadDir,
            );
            await fs.unlink(safePath);
            fileMap.delete(id);
          } catch (err) {
            errorHandler.handle(
              err,
              { context: 'file.delete', fileId: id, code: ErrorCodes.SYSTEM_ERROR }
            );
            RuntimeUtil.makeLog('error', `删除文件失败: ${err.message}`, 'FileAPI');
          }
        }

        HttpResponse.success(res, null, '文件已删除');
      }, 'file.delete')
    },

    {
      method: 'GET',
      path: '/api/files',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const files = Array.from(fileMap.values()).map(f => ({
          id: f.id,
          name: f.name,
          url: f.url,
          size: f.size,
          mime: f.mime,
          is_media: f.is_media,
          upload_time: f.upload_time
        }));

        HttpResponse.success(res, {
          files,
          total: files.length,
          timestamp: Date.now()
        });
      }, 'file.list')
    }
  ],

  init() {
    if (__runtime) __runtime.dispose();
    __runtime = new Disposables();
    // 定期清理过期文件
    __runtime.interval(async () => {
        const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24小时
      
      for (const [id, info] of fileMap) {
        if (now - info.upload_time > maxAge) {
          try {
            await fs.unlink(info.path);
            fileMap.delete(id);
            RuntimeUtil.makeLog('debug', `清理过期文件: ${info.name}`, 'FileAPI');
          } catch {}
        }
      }
    }, 60 * 60 * 1000);
  },

  stop() {
    if (__runtime) __runtime.dispose();
    __runtime = null;
  }
};