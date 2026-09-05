// @ts-nocheck
import { buildLlmProvidersFromPreset } from './llm-provider-fields.js';

/**
 * LLM 工厂子配置写法：一份 meta，挂到 llm_factories 多文件下。
 * YAML 仍是 data/server_bots/{port}/<name>.yaml（与 LLMFactory.configKey 一致）。
 *
 * @param {{ name: string, displayName: string, description?: string, preset: string }} opts
 */
export function defineLlmFactoryMeta({ name, displayName, description, preset }) {
  if (!name || !preset) throw new Error('defineLlmFactoryMeta: 需要 name 与 preset');
  return {
    name,
    displayName: displayName || name,
    description: description || `${displayName || name}（providers[]）`,
    filePath: (runtimeConfig) => {
      const port = runtimeConfig?.port ?? runtimeConfig?._port;
      if (!port) throw new Error(`${name}: 未提供端口，无法解析路径`);
      return `data/server_bots/${port}/${name}.yaml`;
    },
    fileType: 'yaml',
    schema: {
      fields: {
        providers: buildLlmProvidersFromPreset(preset),
      },
    },
  };
}
