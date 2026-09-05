/**
 * 配置管理API
 * 提供统一的配置文件读写接口
 */
import RuntimeUtil from '#utils/runtime-util.js';
import runtimeConfig from '#infrastructure/config/config.js';
import CommonConfigRegistry from '#infrastructure/commonconfig/loader.js';
import { HttpResponse } from '#utils/http-utils.js';

const getConfig = (name: any) => CommonConfigRegistry?.get(name);

/** 多文件配置：system / llm_factories 等（有 configFiles + getConfigInstance） */
function isMultiFileConfig(config: any) {
  return Boolean(config?.configFiles && typeof config.getConfigInstance === 'function');
}

/** CommonConfig 写入后清 runtimeConfig 内存缓存，使 LLMFactory 等立即读到新 providers[] */
function invalidateRuntimeCfgCache(configName: any) {
  if (!runtimeConfig?.config || !configName) return;
  delete runtimeConfig.config[`global.${configName}`];
  const port = runtimeConfig.port;
  if (port) delete runtimeConfig.config[`server.${port}.${configName}`];
}

const resolveConfigInstance = (name: any, keyPath: any) => {
  const config = getConfig(name);
  if (!config) return { error: `配置 ${name} 不存在` };
  if (isMultiFileConfig(config)) {
    if (!keyPath) return { error: `${config.displayName || name} 需要提供 path（子配置名称）` };
    return { config: config.getConfigInstance(keyPath), multi: true };
  }
  return { config, multi: false };
};

// 严格模式：不做任何回退或清洗，完全依赖 schema 校验与前端输入标准化
export default {
  name: 'config-manager',
  dsc: '配置管理API - 统一的配置文件读写接口',
  priority: 85,

  routes: [
    {
      method: 'GET',
      path: '/api/config/list',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        let configList = ((globalThis as any).CommonConfigRegistry?.getList?.() || []);
        // 确保 system 配置排在第一位，其余按名称排序，提升前端展示的一致性
        const rank = (n: any) => (n === 'system' ? 0 : n === 'llm_factories' ? 1 : 2);
        configList = configList.slice().sort((a: any, b: any) => {
          const dr = rank(a.name) - rank(b.name);
          if (dr !== 0) return dr;
          const an = (a.displayName || a.name || '').toLowerCase();
          const bn = (b.displayName || b.name || '').toLowerCase();
          return an.localeCompare(bn, 'zh-CN');
        });
        HttpResponse.success(res, {
          configs: configList,
          count: configList.length
        });
      }, 'config.list')
    },

    {
      method: 'GET',
      path: '/api/config/:name/structure',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const config = getConfig(name);
        if (!config) return HttpResponse.notFound(res, `配置 ${name} 不存在`);
        const structure = config.getStructure();
        HttpResponse.success(res, { structure });
      }, 'config.structure')
    },

    // 扁平化结构（用于减少前端嵌套操作）
    {
      method: 'GET',
      path: '/api/config/:name/flat-structure',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const { path: keyPath } = req.query || {};
        const { config, error, multi } = resolveConfigInstance(name, keyPath);
        if (error) return HttpResponse.error(res, new Error(error), multi || keyPath ? 400 : 404, 'config.flat-structure');
        const flat = config.getFlatSchema();
        HttpResponse.success(res, { flat });
      }, 'config.flat-structure')
    },

    // 扁平化数据（当前值）
    {
      method: 'GET',
      path: '/api/config/:name/flat',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const { path: keyPath } = req.query || {};
        const { config, error, multi } = resolveConfigInstance(name, keyPath);
        if (error) return HttpResponse.error(res, new Error(error), multi || keyPath ? 400 : 404, 'config.flat');
        const data = await config.read();
        const flat = config.flattenData(data);
        HttpResponse.success(res, { flat });
      }, 'config.flat')
    },

    // 批量扁平写入：一次提交多个 path=>value，后端展开/校验/写入
    {
      method: 'POST',
      path: '/api/config/:name/batch-set',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const { flat, path: keyPath, backup = true, validate = true } = req.body || {};
        if (!flat || typeof flat !== 'object') {
          return HttpResponse.validationError(res, '缺少 flat 对象');
        }
        const { config, error, multi } = resolveConfigInstance(name, keyPath);
        if (error) {
          return HttpResponse.error(res, new Error(error), multi || keyPath ? 400 : 404, 'config.batch-set');
        }

        const current = await config.read(false);
        // 注意：这里的 flat 是“精确路径集合”，语义应该是“只覆盖这些路径”，而不是深合并整个对象。
        // 否则像 headers/extraBody 这类 object/map 字段无法被清空（{} 深合并会保留旧键）。
        // null/undefined：删除该路径（如 chatbot 根级群号覆盖被移除）
        const merged = JSON.parse(JSON.stringify(current ?? {}));
        for (const [p, v] of Object.entries(flat)) {
          if (v === null || v === undefined) {
            config._deleteValueByPath(merged, p);
          } else {
            config._setValueByPath(merged, p, v);
          }
        }

        // 校验并写入
        const valid = await config.validate(merged);
        if (!valid.valid) {
          RuntimeUtil.makeLog('warn', `配置验证失败 [${name}${keyPath ? '/' + keyPath : ''}]: ${valid.errors.join('; ')}`, 'ConfigAPI');
          return HttpResponse.validationError(res, `校验失败: ${valid.errors.join('; ')}`);
        }
        await config.write(merged, { backup, validate });
        const cacheKey = multi ? keyPath : name;
        if (cacheKey) invalidateRuntimeCfgCache(cacheKey);
        HttpResponse.success(res, null, '批量写入成功');
      }, 'config.batch-set')
    },

    {
      method: 'GET',
      path: '/api/config/:name/read',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const configName = req.params?.name;
        const { path: keyPath } = req.query || {};
        if (!configName) return HttpResponse.validationError(res, '配置名称不能为空');
        if (!(globalThis as any).CommonConfigRegistry) return HttpResponse.error(res, new Error('配置管理器未初始化'), 503, 'config.read');
        const { config, error, multi } = resolveConfigInstance(configName, keyPath);
        if (error) return HttpResponse.notFound(res, error);
        let data;
        if (multi && keyPath) data = await config.read();
        else if (keyPath && typeof config.get === 'function') data = await config.get(keyPath);
        else if (typeof config.read === 'function') data = await config.read();
        else throw new Error('配置对象不支持 read/get 方法');
        HttpResponse.success(res, { data });
      }, 'config.read')
    },

    {
      method: 'POST',
      path: '/api/config/:name/write',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const configName = req.params?.name;
        const { data, path: keyPath, backup = true, validate = true } = req.body || {};

        if (!configName) {
          return HttpResponse.validationError(res, '配置名称不能为空');
        }

        if (!(globalThis as any).CommonConfigRegistry) return HttpResponse.error(res, new Error('配置管理器未初始化'), 503, 'config.write');
        const config = getConfig(configName);
        if (!config) return HttpResponse.notFound(res, `配置 ${configName} 不存在`);
        const multi = isMultiFileConfig(config);
        let result;
        if (keyPath) {
          if (multi && typeof config.write === 'function') {
            result = await config.write(keyPath, data, { backup, validate });
          } else if (typeof config.set === 'function') {
            result = await config.set(keyPath, data, { backup, validate });
          } else {
            throw new Error('配置对象不支持 set 方法');
          }
        } else {
          if (multi) {
            throw new Error(`${config.displayName || configName} 需要指定子配置名称（使用 path 参数）`);
          } else if (typeof config.write === 'function') {
            result = await config.write(data, { backup, validate });
          } else {
            throw new Error('配置对象不支持 write 方法');
          }
        }

        const cacheKey = multi ? keyPath : configName;
        if (cacheKey) invalidateRuntimeCfgCache(cacheKey);
        HttpResponse.success(res, { result }, '配置已保存');
      }, 'config.write')
    },

    {
      method: 'POST',
      path: '/api/config/:name/validate',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const { data } = req.body;
        const config = getConfig(name);
        if (!config) return HttpResponse.notFound(res, `配置 ${name} 不存在`);
        const validation = await config.validate(data);
        HttpResponse.success(res, { validation });
      }, 'config.validate')
    },

    {
      method: 'POST',
      path: '/api/config/:name/backup',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const config = getConfig(name);
        if (!config) return HttpResponse.notFound(res, `配置 ${name} 不存在`);
        const backupPath = await config.backup();
        HttpResponse.success(res, { backupPath }, '配置已备份');
      }, 'config.backup')
    },

    {
      method: 'POST',
      path: '/api/config/:name/reset',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        const { name } = req.params;
        const { backup = true } = req.body;
        const config = getConfig(name);
        if (!config) return HttpResponse.notFound(res, `配置 ${name} 不存在`);
        const result = await config.reset({ backup });
        HttpResponse.success(res, { result }, '配置已重置为默认值');
      }, 'config.reset')
    },

    {
      method: 'POST',
      path: '/api/config/clear-cache',
      handler: HttpResponse.asyncHandler(async (req: any, res: any) => {
        (globalThis as any).CommonConfigRegistry.clearAllCache();
        HttpResponse.success(res, null, '已清除所有配置缓存');
      }, 'config.clear-cache')
    }
  ]
};