/**
 * 配置常量定义
 * 统一管理全局配置、服务器配置和工厂配置的分类
 *
 * 通道配置（如 feishu）：由各 Core 的 commonconfig 提供，通过 CommonConfigRegistry.get('feishu') 等访问；
 * 文件路径约定为 data/server_bots/{port}/<name>.yaml，与底层 config.getConfigDir() 一致。
 * 不列入 GLOBAL_CONFIGS/SERVER_CONFIGS，避免与 config/default_config 冲突。
 */

// 全局配置列表（不随端口变化，存储在server_bots/根目录）
export const GLOBAL_CONFIGS = ['agt', 'device', 'monitor', 'redis', 'sqlite'] as const;

export type GlobalConfigName = (typeof GLOBAL_CONFIGS)[number];

// 服务器配置列表（随端口变化，存储在server_bots/{port}/）
export const SERVER_CONFIGS = ['server', 'chatbot', 'ai-workflow'] as const;

export type ServerConfigName = (typeof SERVER_CONFIGS)[number];

/**
 * chatbot.yaml 根级固定键（其余根级键视为群号覆盖，供 getGroup / collections 排除）
 */
export const CHATBOT_FIXED_ROOT_KEYS = [
  'master',
  'auto',
  'private',
  'whitelist',
  'blacklist',
  'guild',
  'default',
] as const;

export type ChatbotFixedRootKey = (typeof CHATBOT_FIXED_ROOT_KEYS)[number];

// 工厂配置名称模式（随端口变化）
export const FACTORY_CONFIG_PATTERNS = [
  'volcengine_',
  'deepseek_',
  'xiaomimimo_',
  'openai_',
  'gemini_',
  'anthropic_',
  'azure_',
  'ollama_',
  'newapi_',
  'cherryin_',
] as const;

/**
 * 判断配置名称是否为工厂配置
 */
export function isFactoryConfig(configName: string): boolean {
  return FACTORY_CONFIG_PATTERNS.some((pattern) => configName.includes(pattern));
}

export function isGlobalConfig(configName: string): configName is GlobalConfigName {
  return (GLOBAL_CONFIGS as readonly string[]).includes(configName);
}

export function isServerConfig(configName: string): configName is ServerConfigName {
  return (SERVER_CONFIGS as readonly string[]).includes(configName);
}

export function isChatbotFixedRootKey(id: string): id is ChatbotFixedRootKey {
  return (CHATBOT_FIXED_ROOT_KEYS as readonly string[]).includes(id);
}

/**
 * 判断配置名称是否为服务器配置（包括服务器配置和工厂配置）
 */
export function isServerOrFactoryConfig(configName: string): boolean {
  return isServerConfig(configName) || isFactoryConfig(configName);
}
