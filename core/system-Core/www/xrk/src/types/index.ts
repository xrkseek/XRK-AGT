/**
 * 控制台共享类型骨架（由底层 Runtime / HTTP 契约反推）
 *
 * 权威口径：
 * - HTTP 解包语义见 `src/utils/http.ts`（对齐 `core/system-Core/www/xrk/modules/web-compat.js`）
 * - segments 形态由 Runtime `msgSegment` 决定
 * - 配置字段由 `src/config/flat.ts` 的 FIELD_TABLE 决定
 */

/* ============ 通用 ============ */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** 任意 JSON 载荷的宽松读取（WS / HTTP 反序列化后） */
export interface LoosePayload {
  [k: string]: any;
}

/** HttpResponse.success 解包后的形状（success/message + 拍平字段或 data） */
export interface SuccessEnvelope<T = any> extends LoosePayload {
  success?: boolean;
  message?: string;
  data?: T;
}

/* ============ 鉴权 ============ */

export type ServerAuthState = 'unknown' | 'ok' | 'unauthorized';
export type AuthMode = 'unknown' | 'enforced' | 'bypass';
export type BadgeTone = 'error' | 'success' | 'warning';

export interface AuthBadge {
  type: BadgeTone;
  text: string;
  title: string;
}

export interface AuthModeResponse {
  requiresKey?: boolean;
  [k: string]: any;
}

/* ============ segments（对齐 Runtime msgSegment） ============ */

export interface SegmentBase {
  type: string;
  [k: string]: any;
}

export interface TextSegment extends SegmentBase {
  type: 'text';
  text: string;
}

export interface MarkdownSegment extends SegmentBase {
  type: 'markdown';
  text: string;
}

export interface RawSegment extends SegmentBase {
  type: 'raw';
  text: string;
}

export interface ImageSegment extends SegmentBase {
  type: 'image';
  url: string;
  name?: string;
}

export interface VideoSegment extends SegmentBase {
  type: 'video';
  url: string;
  name?: string;
}

export interface RecordSegment extends SegmentBase {
  type: 'record';
  url: string;
  name?: string;
}

export interface FileSegment extends SegmentBase {
  type: 'file';
  url: string;
  name?: string;
}

export interface AtSegment extends SegmentBase {
  type: 'at';
  qq: string;
  name: string;
}

export interface ReplySegment extends SegmentBase {
  type: 'reply';
  id: string | number;
  text: string;
}

export interface ForwardSegment extends SegmentBase {
  type: 'forward';
  id: string;
  segments: NormalizedSegment[];
  text: string;
}

export interface PokeSegment extends SegmentBase {
  type: 'poke';
  qq: string;
  text: string;
}

export interface ToolsSegment extends SegmentBase {
  type: 'tools';
  tools: LoosePayload[];
}

export type NormalizedSegment =
  | TextSegment
  | MarkdownSegment
  | RawSegment
  | ImageSegment
  | VideoSegment
  | RecordSegment
  | FileSegment
  | AtSegment
  | ReplySegment
  | ForwardSegment
  | PokeSegment
  | ToolsSegment;

/* ============ 聊天历史 ============ */

export type ChatMode = 'ai' | 'event' | 'voice';

export interface McpToolEntry {
  name?: string;
  [k: string]: any;
}

export interface HistoryItem {
  id: string;
  role: string;
  text: string;
  content: string;
  segments: NormalizedSegment[];
  ts: number;
  mcpTools?: McpToolEntry[];
  source?: string;
  /** 聊天记录卡（合并转发） */
  type?: 'record';
  title?: string;
  description?: string;
  messages?: LoosePayload[];
  [k: string]: any;
}

export interface MakeHistoryOptions {
  text?: string;
  segments?: NormalizedSegment[] | null;
  extra?: LoosePayload;
}

/* ============ HTTP ============ */

export interface ApiFetchOptions extends Omit<RequestInit, 'headers'> {
  timeoutMs?: number;
  raw?: boolean;
  headers?: Record<string, string>;
}