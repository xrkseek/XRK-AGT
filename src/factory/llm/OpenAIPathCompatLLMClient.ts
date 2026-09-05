import OpenAICompatibleLLMClient from './OpenAICompatibleLLMClient.js'
import { buildOpenAICompatEndpoint } from '#utils/llm/openai-chat-utils.js'

/** New-API / CherryIN 等路径型 OpenAI Chat Completions 兼容工厂共用实现 */
export default class OpenAIPathCompatLLMClient extends OpenAICompatibleLLMClient {
  normalizeEndpoint(config: Record<string, any>) {
    const label =
      String(config.factoryType || config.protocol || 'path_compat').replace(/_llm$/i, '') ||
      'path_compat'
    return buildOpenAICompatEndpoint(config, {
      defaultPath: config.path || '/v1/chat/completions',
      label
    })
  }
}
