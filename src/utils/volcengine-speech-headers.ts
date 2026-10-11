/**
 * 火山引擎语音（ASR/TTS）WebSocket 鉴权头。
 * 新控制台：仅 X-Api-Key；旧控制台：X-Api-App-Key + X-Api-Access-Key。
 * @see https://www.volcengine.com/docs/6561/1354869 （大模型流式 ASR）
 * @see https://www.volcengine.com/docs/6561/1329505 （V3 TTS 双向流式，同类头字段）
 */

export function buildVolcengineSpeechHeaders(
  config: {
    resourceId?: unknown;
    apiKey?: unknown;
    xApiKey?: unknown;
    appKey?: unknown;
    accessKey?: unknown;
  } = {},
  opts: {
    connectId?: string;
    requestId?: string;
    sequence?: number | string;
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  const resourceId = String(config.resourceId ?? '').trim();
  if (resourceId) headers['X-Api-Resource-Id'] = resourceId;

  const connectId = opts.connectId != null ? String(opts.connectId).trim() : '';
  const requestId = opts.requestId != null ? String(opts.requestId).trim() : connectId;
  if (connectId) headers['X-Api-Connect-Id'] = connectId;
  if (requestId) headers['X-Api-Request-Id'] = requestId;

  // 官方鉴权表：发包序号固定 -1
  headers['X-Api-Sequence'] = String(opts.sequence ?? -1);

  const apiKey = String(config.apiKey ?? config.xApiKey ?? '').trim();
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
    return headers;
  }

  const appKey = String(config.appKey ?? '').trim();
  const accessKey = String(config.accessKey ?? '').trim();
  if (appKey) headers['X-Api-App-Key'] = appKey;
  if (accessKey) headers['X-Api-Access-Key'] = accessKey;
  return headers;
}
