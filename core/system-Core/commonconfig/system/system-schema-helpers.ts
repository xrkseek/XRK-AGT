// @ts-nocheck
import { GLOBAL_CONFIGS } from '#infrastructure/config/config-constants.js';
import { SUBSERVER_RUNTIME_CATALOG } from '#utils/subserver-runtimes.js';

/** 子服务单个 runtime 端点（commonconfig ↔ ai-workflow.yaml subserver.runtimes） */
export function subserverRuntimeEndpointFields(defaultPort) {
  return {
    enabled: {
      type: 'boolean',
      label: '启用',
      default: true,
      component: 'Switch'
    },
    host: {
      type: 'string',
      label: '地址',
      default: '127.0.0.1',
      component: 'Input',
      placeholder: '127.0.0.1'
    },
    port: {
      type: 'number',
      label: '端口',
      default: defaultPort,
      min: 1024,
      max: 65535,
      component: 'InputNumber'
    }
  };
}

/** commonconfig 子服务 runtimes 字段（与 SUBSERVER_RUNTIME_CATALOG 同步） */
export function subserverRuntimeSubFormFields() {
  return Object.fromEntries(
    Object.entries(SUBSERVER_RUNTIME_CATALOG).map(([id, meta]) => [
      id,
      {
        type: 'object',
        label: `${meta.label} · ${id}`,
        component: 'SubForm',
        fields: subserverRuntimeEndpointFields(meta.port)
      }
    ])
  );
}

/**
 * crawl.webSearch 提供商凭据 SubForm 字段（commonconfig 与 ai-workflow.yaml 对齐）
 * @param {string} providerLabel 提供商显示名（写入 label，避免多组同名「API Key」）
 * @param {Record<string, object>} [extraFields]
 */
export function crawlProviderApiFields(providerLabel, extraFields = {}) {
  // 兼容旧调用 crawlProviderApiFields({ model: … })
  if (providerLabel && typeof providerLabel === 'object' && !Array.isArray(providerLabel)) {
    extraFields = providerLabel;
    providerLabel = '';
  }
  const name = String(providerLabel || '').trim();
  const who = name || '该搜索提供商';
  return {
    apiKey: {
      type: 'string',
      label: name ? `${name} API Key` : 'API Key',
      description: `${who} 的鉴权密钥。留空则跳过，不参与 web_search 自动选择。`,
      default: '',
      component: 'Input',
      layout: 'full'
    },
    baseUrl: {
      type: 'string',
      label: name ? `${name} Base URL（可选）` : 'Base URL（可选）',
      description: `一般留空用官方默认地址。仅自建或反向代理 ${who} 时填写 API 根 URL。`,
      default: '',
      component: 'Input',
      layout: 'full'
    },
    ...extraFields
  };
}

/** 辅助：获取端口号 */
export function getPort(runtimeConfig) {
  return runtimeConfig?.port ?? runtimeConfig?._port;
}

/** 辅助：生成配置路径（全局 vs 按端口） */
export function getConfigPath(configName) {
  return (runtimeConfig) => {
    if (GLOBAL_CONFIGS.includes(configName)) {
      return `data/server_bots/${configName}.yaml`;
    }
    const port = getPort(runtimeConfig);
    if (!port) {
      throw new Error(`SystemConfig: 配置 ${configName} 需要端口号`);
    }
    return `data/server_bots/${port}/${configName}.yaml`;
  };
}
