import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { HttpResponse } from '#utils/http-utils.js';
import { InputValidator } from '#utils/input-validator.js';


/**
 * 判断是否为对象
 */
function isObject(item: any) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * 深度合并对象
 */
function deepMerge(target: any, source: any) {
  const output = { ...target };
  
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key: any) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          output[key] = source[key];
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        output[key] = source[key];
      }
    });
  }
  
  return output;
}

/**
 * 更新嵌套对象的值
 */
function updateNestedValue(obj: any, path: any, value: any) {
  const keys = path.split('.');
  const result = { ...obj };
  let current = result;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  
  current[keys[keys.length - 1]] = value;
  return result;
}

/**
 * 数据编辑管理API
 * 支持JSON和YAML文件的读写操作
 */
export default {
  name: 'data-editor',
  dsc: '数据编辑管理API - 支持JSON和YAML文件操作',
  priority: 75,

  routes: [
    {
      method: 'GET',
      path: '/api/data/read',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { filePath, encoding = 'utf8' } = req.query;
        
        if (!filePath) {
          return HttpResponse.validationError(res, '缺少文件路径参数');
        }
        
        // 使用InputValidator验证路径（防止路径遍历）
        const normalizedPath = InputValidator.validatePath(filePath, process.cwd());
        
        try {
          await fs.access(normalizedPath);
        } catch {
          return HttpResponse.notFound(res, '文件不存在');
        }

        const content = await fs.readFile(normalizedPath, encoding);
        const ext = path.extname(normalizedPath).toLowerCase();
        
        let data;
        let fileType;
        if (ext === '.json') {
          data = JSON.parse(content as any);
          fileType = 'json';
        } else if (['.yml', '.yaml'].includes(ext)) {
          data = yaml.parse(content as any);
          fileType = 'yaml';
        } else {
          try {
            data = JSON.parse(content as any);
            fileType = 'json';
          } catch {
            data = content;
            fileType = 'text';
          }
        }
        
        const stats = await fs.stat(normalizedPath);
        
        HttpResponse.success(res, {
          data,
          metadata: {
            path: normalizedPath,
            type: fileType,
            size: stats.size,
            modified: stats.mtime,
            created: stats.birthtime
          }
        });
      }, 'data.read')
    },

    {
      method: 'POST',
      path: '/api/data/write',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const {
          filePath, 
          data, 
          format,
          operation = 'overwrite',
          createIfNotExist = true,
          backup = true,
          encoding = 'utf8',
          options = {}
        } = req.body;

        if (!filePath || data === undefined) {
          return HttpResponse.validationError(res, '缺少必要参数');
        }

        // 使用InputValidator验证路径
        const normalizedPath = InputValidator.validatePath(filePath, process.cwd());

        const ext = path.extname(normalizedPath).toLowerCase();
        const fileFormat = format || (ext === '.json' ? 'json' : 
                          ['.yml', '.yaml'].includes(ext) ? 'yaml' : 'json');

        let fileExists = true;
        try {
          await fs.access(normalizedPath);
        } catch {
          fileExists = false;
          if (!createIfNotExist) {
            return HttpResponse.notFound(res, '文件不存在且不允许创建');
          }
        }

        let finalData = data;

        if (fileExists && operation !== 'overwrite') {
          const existingContent = await fs.readFile(normalizedPath, encoding);
          let existingData;
          
          try {
            existingData = fileFormat === 'json' 
              ? JSON.parse(existingContent as any)
              : yaml.parse(existingContent as any);
          } catch (error: any) {
            return HttpResponse.validationError(res, `现有文件格式错误: ${error.message}`);
          }

          switch (operation) {
            case 'merge':
              if (isObject(existingData) && isObject(data)) {
                finalData = deepMerge(existingData, data);
              } else {
                finalData = data;
              }
              break;
              
            case 'append':
              if (Array.isArray(existingData)) {
                finalData = existingData.concat(Array.isArray(data) ? data : [data]);
              } else {
                return HttpResponse.validationError(res, 'append操作仅支持数组');
              }
              break;
              
            case 'update':
              if (req.body.path && isObject(existingData)) {
                finalData = updateNestedValue(existingData, req.body.path, data);
              } else {
                finalData = data;
              }
              break;
          }
        }

        let backupPath: any = null;
        if (backup && fileExists) {
          backupPath = `${normalizedPath}.backup.${Date.now()}`;
          await fs.copyFile(normalizedPath, backupPath);
        }

        const dir = path.dirname(normalizedPath);
        await fs.mkdir(dir, { recursive: true });

        let content;
        if (fileFormat === 'json') {
          const indent = options.indent || 2;
          content = JSON.stringify(finalData, null, indent);
        } else {
          const yamlOptions = {
            indent: options.indent || 2,
            ...options
          };
          content = yaml.stringify(finalData, yamlOptions);
        }

        await fs.writeFile(normalizedPath, content, encoding);

        HttpResponse.success(res, {
          metadata: {
            path: normalizedPath,
            format: fileFormat,
            operation,
            backup: backupPath
          }
        }, `${fileFormat.toUpperCase()}文件写入成功`);
      }, 'data.write')
    }
  ],
};