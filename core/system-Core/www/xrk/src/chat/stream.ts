/**
 * 对齐原 app._parseV3Stream：SSE 文本增量 + mcp_tools 穿插 segments
 */
import type { LoosePayload, NormalizedSegment } from '@/types';
import type { ToolLike } from '@/chat/tools';

/** 流式解析的累积状态 */
export interface StreamState {
  fullText: string;
  currentText: string;
  segments: NormalizedSegment[];
  mcpTools: ToolLike[];
  error: Error | null;
}

export interface StreamCallbacks {
  signal?: AbortSignal;
  onDelta?: (delta: string, state: StreamState) => void;
  onError?: (err: Error) => void;
  onTools?: (tools: ToolLike[]) => void;
}

export async function parseV3Stream(
  response: Response,
  callbacks: StreamCallbacks = {},
): Promise<StreamState> {
  const state: StreamState = {
    fullText: '',
    currentText: '',
    segments: [],
    mcpTools: [],
    error: null,
  };
  const { onDelta, onError, onTools, signal } = callbacks;

  if (!response.ok || !response.body) {
    const raw = await response.text().catch(() => '');
    state.error = new Error(`HTTP ${response.status}: ${raw}`);
    onError?.(state.error);
    return state;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const abort = () => {
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) {
      abort();
      state.error = new Error('Aborted');
      return state;
    }
    signal.addEventListener('abort', abort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue;
        const data = line.replace(/^data:\s?/, '').trim();
        if (data === '[DONE]') {
          if (state.currentText) {
            state.segments.push({ type: 'text', text: state.currentText });
            state.currentText = '';
          }
          return state;
        }
        let json: LoosePayload;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          state.error = new Error(json.error.message || 'AI 请求失败');
          onError?.(state.error);
          return state;
        }
        if (Array.isArray(json.mcp_tools) && json.mcp_tools.length) {
          const tools = (json.mcp_tools as ToolLike[]).filter((tool) => {
            if (!tool) return false;
            if (tool.name || tool.function?.name) return true;
            if (tool.result || tool.content) return true;
            return false;
          });
          if (tools.length) {
            if (state.currentText) {
              state.segments.push({ type: 'text', text: state.currentText });
              state.currentText = '';
            }
            state.segments.push({ type: 'tools', tools });
            state.mcpTools = state.mcpTools.concat(tools);
            onTools?.(tools);
            onDelta?.('', state);
          }
        }
        const delta =
          json.choices?.[0]?.delta?.content ||
          json.choices?.[0]?.message?.content ||
          json.content ||
          '';
        if (delta) {
          state.fullText += delta;
          state.currentText += delta;
          onDelta?.(delta, state);
        }
      }
    }
    if (state.currentText) {
      state.segments.push({ type: 'text', text: state.currentText });
      state.currentText = '';
    }
  } catch (err) {
    if ((err as Error)?.name !== 'AbortError') {
      state.error = err instanceof Error ? err : new Error(String(err));
      onError?.(state.error);
    } else {
      state.error = err as Error;
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
  return state;
}

/** 流式过程中用于 UI 的完整 segments（已闭合 + 当前文本） */
export function liveSegments(state: Partial<StreamState>): NormalizedSegment[] {
  const segs: NormalizedSegment[] = [...(state.segments || [])];
  const cur = state.currentText ?? '';
  if (cur) segs.push({ type: 'text', text: cur });
  return segs;
}
