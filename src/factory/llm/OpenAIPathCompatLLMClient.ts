import OpenAICompatibleLLMClient from './OpenAICompatibleLLMClient.js'
import { buildOpenAICompatEndpoint } from '#utils/llm/openai-chat-utils.js'

type PathCompatConfig = Record<string, unknown> & {
  factoryType?: string;
  protocol?: string;
  path?: string;
};

/** New-API / CherryIN 等路径型 OpenAI Chat Completions 兼容工厂共用实现 */
export default class OpenAIPathCompatLLMClient extends OpenAICompatibleLLMClient {
  normalizeEndpoint(config: PathCompatConfig) {
    const label =
      String(config.factoryType || config.protocol || 'path_compat').replace(/_llm$/i, '') ||
      'path_compat'
    return buildOpenAICompatEndpoint(config, {
      defaultPath: (config.path as string | undefined) || '/v1/chat/completions',
      label
    })
  }
}
