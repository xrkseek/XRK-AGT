/**
 * HTTP 网关协议适配入口（OpenAI Chat / Models / Anthropic Messages / OpenAI Responses）
 */
export {
  listProviderModelIds,
  buildOpenAIModelsPayload,
  buildOpenAIModelPayload,
  buildConsoleLlmCatalog
} from './models.js';

export {
  anthropicMessagesToOpenAIBody,
  openAIChatToAnthropicMessage,
  initAnthropicMessageSSE,
  pipeAnthropicMessagesStream
} from './anthropic.js';

export {
  responsesInputToMessages,
  responsesRequestToOpenAIBody,
  openAIChatToResponsesObject,
  initResponsesSSE,
  pipeResponsesStream
} from './responses.js';

export { initGatewaySSE, writeNamedSSE, writeDataSSE } from './sse.js';
