/** 网关 SSE 共用响应头 */
export function initGatewaySSE(res: any) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** Anthropic / Responses：`event:` + `data:` */
export function writeNamedSSE(res: any, event: any, payload: any) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}

/** OpenAI Chat Completions：仅 `data:` */
export function writeDataSSE(res: any, payload: any) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (typeof res.flush === 'function') res.flush();
}
