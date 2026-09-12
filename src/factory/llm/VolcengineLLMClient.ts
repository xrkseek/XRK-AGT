import OpenAIResponsesCompatibleLLMClient from './OpenAIResponsesCompatibleLLMClient.js';

/**
 * 火山方舟（Ark）Responses API 客户端
 *
 * @see https://www.volcengine.com/docs/82379/1569618
 * - 端点：`POST {baseUrl}/responses`（默认 baseUrl=`https://ark.cn-beijing.volces.com/api/v3`）
 * - 鉴权：`Authorization: Bearer <API Key>`
 * - 深度思考：`thinking.type` = enabled | disabled | auto；力度用 `reasoning.effort`（Responses）
 * - 多模态 / 工具：Responses `input` + `function_call` / `function_call_output`
 *
 * harness：`createLlmFromConfig` 对 path~/responses/ 或 provider~/responses/ 走
 * `createOpenAiResponsesAdapter`；与本客户端协议一致。
 */

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seed-2-0-lite-260428';

type VolcConfig = Record<string, unknown> & {
  baseUrl?: string;
  region?: string;
  path?: string;
  model?: string;
  thinkingType?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
};

type VolcOverrides = Record<string, unknown> & {
  thinkingType?: string;
  reasoningEffort?: string;
  reasoning_effort?: string;
};

type VolcBody = Record<string, unknown> & {
  model?: unknown;
  input?: unknown;
  stream?: boolean;
  thinking?: { type: string };
  reasoning?: Record<string, unknown> & { effort?: string };
  reasoning_effort?: unknown;
};

export default class VolcengineLLMClient extends OpenAIResponsesCompatibleLLMClient {
  declare config: VolcConfig;

  constructor(config: VolcConfig = {}) {
    const baseUrl = config.baseUrl
      ? String(config.baseUrl).replace(/\/+$/, '')
      : config.region
        ? `https://ark.${config.region}.volces.com/api/v3`
        : DEFAULT_BASE_URL;

    super({
      ...config,
      baseUrl,
      path: config.path || '/responses',
      model: config.model || DEFAULT_MODEL,
    });
  }

  buildBody(
    input: unknown,
    overrides: VolcOverrides = {},
    opts: { stream?: boolean } = {},
  ): VolcBody {
    const body = super.buildBody(input as never, overrides, opts) as VolcBody;
    if (!body.model) body.model = DEFAULT_MODEL;

    const rawThinking = overrides.thinkingType ?? this.config.thinkingType;
    const thinkingType =
      rawThinking != null && rawThinking !== '' ? String(rawThinking).trim().toLowerCase() : '';
    if (thinkingType === 'enabled' || thinkingType === 'disabled' || thinkingType === 'auto') {
      body.thinking = { type: thinkingType };
    }

    const rawEffort =
      overrides.reasoningEffort ??
      overrides.reasoning_effort ??
      this.config.reasoningEffort ??
      this.config.reasoning_effort;
    delete body.reasoning_effort;
    if (rawEffort != null && rawEffort !== '' && thinkingType !== 'disabled') {
      const prev = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {};
      body.reasoning = { ...prev, effort: String(rawEffort).trim().toLowerCase() };
    } else if (thinkingType === 'disabled' && body.reasoning?.effort !== undefined) {
      const { effort: _drop, ...rest } = body.reasoning;
      if (Object.keys(rest).length) body.reasoning = rest;
      else delete body.reasoning;
    }

    return body;
  }
}
