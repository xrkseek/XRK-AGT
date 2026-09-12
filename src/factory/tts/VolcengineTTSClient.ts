/**
 * 火山引擎TTS客户端（V3双向流式协议）
 * 实现文本转语音功能，支持实时流式合成。
 * 流式/Opus 场景必须请求 format=pcm，否则服务端可能返回 wav（多次 header）或 mp3，导致下游当 PCM 处理出错。
 */

// @ts-expect-error no @types/ws
import WebSocket from 'ws';
import zlib from 'node:zlib';
import { v4 as uuidv4 } from 'uuid';
import RuntimeUtil from '#utils/runtime-util.js';
import { buildVolcengineSpeechHeaders } from '#utils/volcengine-speech-headers.js';
import { normalizeError } from '#utils/normalize-error.js';

const TTS_EVENTS = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  CONNECTION_FINISHED: 52,
  START_SESSION: 100,
  CANCEL_SESSION: 101,
  FINISH_SESSION: 102,
  SESSION_STARTED: 150,
  SESSION_CANCELED: 151,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TASK_REQUEST: 200,
  TTS_SENTENCE_START: 350,
  TTS_SENTENCE_END: 351,
  TTS_RESPONSE: 352,
} as const;

type TtsConfig = Record<string, unknown> & {
  wsUrl?: string;
  sampleRate?: number;
  chunkMs?: number;
  chunkDelayMs?: number;
  voiceType?: string;
  encoding?: string;
  speechRate?: number;
  loudnessRate?: number;
  emotion?: string;
  resourceId?: unknown;
  apiKey?: unknown;
  xApiKey?: unknown;
  appKey?: unknown;
  accessKey?: unknown;
};

type DeviceBotLike = {
  sendAudioChunk?: (hex: string) => Promise<unknown> | unknown;
};

type AgentRuntimeLike = {
  [deviceId: string]: DeviceBotLike | unknown;
};

type SynthesizeOptions = {
  voiceType?: string;
  encoding?: string;
  sampleRate?: number;
  speechRate?: number;
  loudnessRate?: number;
  emotion?: string;
  audioParams?: Record<string, unknown>;
  reqParams?: Record<string, unknown>;
};

type ParsedTtsMessage =
  | { type: 'error'; errorCode: number; errorMessage: string }
  | { type: 'audio'; event: number; sessionId: string; data: Buffer }
  | {
      type: 'event';
      event: number;
      connectionId: string | null;
      sessionId: string | null;
      payload: Record<string, unknown>;
    };

type WsSocket = {
  readyState: number;
  terminate: () => void;
  close: (code?: number, reason?: string) => void;
  send: (data: Buffer) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Error.isError(signal.reason) ? signal.reason : new Error('aborted'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Error.isError(signal?.reason) ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toBuffer(buf: unknown): Buffer | null {
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof ArrayBuffer) return Buffer.from(new Uint8Array(buf));
  if (ArrayBuffer.isView(buf)) return Buffer.from(buf as Uint8Array);
  if (typeof buf === 'string') return Buffer.from(buf);
  return null;
}

export default class VolcengineTTSClient {
  deviceId: string;
  config: TtsConfig;
  AgentRuntime: AgentRuntimeLike;

  /** 音频会话状态：类字段初始化，禁 constructor 内建缓存 */
  ws: WsSocket | null = null;
  connected = false;
  connecting = false;
  connectionId: string | null = null;
  currentSessionId: string | null = null;
  sessionActive = false;
  totalAudioBytes = 0;
  audioChunkCount = 0;
  lastChunkTime: number | null = null;
  sessionStartTime: number | null = null;
  _sessionResolve: (() => void) | null = null;
  _sessionTimeout: ReturnType<typeof setTimeout> | null = null;
  /** 串行化下发：保证多段 audio 按序送设备 */
  _audioSendPromise: Promise<unknown> = Promise.resolve();

  constructor(deviceId: string, config: TtsConfig = {}, AgentRuntime: AgentRuntimeLike) {
    this.deviceId = deviceId;
    this.config = config;
    this.AgentRuntime = AgentRuntime;
  }

  _headers() {
    return buildVolcengineSpeechHeaders(this.config, { connectId: uuidv4() });
  }

  _protoHeader(messageType: number, messageFlags: number, serialization: number, compression: number) {
    const header = Buffer.alloc(4);
    header[0] = 0x11;
    header[1] = (messageType << 4) | messageFlags;
    header[2] = (serialization << 4) | compression;
    header[3] = 0x00;
    return header;
  }

  _buildEventFrame(event: number, sessionId: string | null = null, payload: Record<string, unknown> = {}) {
    const payloadJson = JSON.stringify(payload);
    const payloadBuf = Buffer.from(payloadJson, 'utf-8');

    const header = this._protoHeader(0x1, 0x4, 0x1, 0x0);

    const eventBuf = Buffer.alloc(4);
    eventBuf.writeInt32BE(event, 0);

    let frame = Buffer.concat([header, eventBuf]);

    if (sessionId) {
      const sessionIdBuf = Buffer.from(sessionId, 'utf-8');
      const sessionIdLen = Buffer.alloc(4);
      sessionIdLen.writeUInt32BE(sessionIdBuf.length, 0);
      frame = Buffer.concat([frame, sessionIdLen, sessionIdBuf]);
    }

    const payloadLen = Buffer.alloc(4);
    payloadLen.writeUInt32BE(payloadBuf.length, 0);
    frame = Buffer.concat([frame, payloadLen, payloadBuf]);

    return frame;
  }

  _parse(data: Buffer): ParsedTtsMessage | null {
    try {
      if (!data || data.length < 4) return null;

      const messageType = (data[1]! >> 4) & 0x0f;
      const messageFlags = data[1]! & 0x0f;
      const serialization = (data[2]! >> 4) & 0x0f;
      const compression = data[2]! & 0x0f;

      let offset = 4;

      if (messageType === 0xf) {
        const errCode = data.readInt32BE(offset);
        offset += 4;
        const errLen = data.readUInt32BE(offset);
        offset += 4;
        const errMsg = data.subarray(offset, offset + errLen).toString('utf-8');
        return { type: 'error', errorCode: errCode, errorMessage: errMsg };
      }

      if (messageType === 0xb) {
        const event = data.readInt32BE(offset);
        offset += 4;

        const sessionIdLen = data.readUInt32BE(offset);
        offset += 4;
        const sessionId = data.subarray(offset, offset + sessionIdLen).toString('utf-8');
        offset += sessionIdLen;

        const audioLen = data.readUInt32BE(offset);
        offset += 4;
        const audioBuf = data.subarray(offset, offset + audioLen);

        return {
          type: 'audio',
          event,
          sessionId,
          data: audioBuf,
        };
      }

      if (messageFlags === 0x4) {
        const event = data.readInt32BE(offset);
        offset += 4;

        let connectionId: string | null = null;
        let sessionId: string | null = null;

        if (event >= 50 && event < 100) {
          const connectionIdLen = data.readUInt32BE(offset);
          offset += 4;
          connectionId = data.subarray(offset, offset + connectionIdLen).toString('utf-8');
          offset += connectionIdLen;
        } else if ((event >= 100 && event < 200) || (event >= 350 && event < 400)) {
          const sessionIdLen = data.readUInt32BE(offset);
          offset += 4;
          sessionId = data.subarray(offset, offset + sessionIdLen).toString('utf-8');
          offset += sessionIdLen;
        }

        const payloadLen = data.readUInt32BE(offset);
        offset += 4;
        let payload = data.subarray(offset, offset + payloadLen);

        if (compression === 0x1 && payload.length > 0) {
          try {
            payload = zlib.gunzipSync(payload);
          } catch (gzipErr: unknown) {
            RuntimeUtil.makeLog('warn', `[TTS] Gzip解压失败: ${normalizeError(gzipErr).message}`, this.deviceId);
          }
        }

        let payloadObj: Record<string, unknown> = {};
        if (serialization === 0x1 && payload.length > 0) {
          try {
            const payloadStr = payload.toString('utf-8');
            payloadObj = JSON.parse(payloadStr) as Record<string, unknown>;
          } catch {
            // 忽略解析错误
          }
        }

        return {
          type: 'event',
          event,
          connectionId,
          sessionId,
          payload: payloadObj,
        };
      }

      return null;
    } catch (e: unknown) {
      RuntimeUtil.makeLog('error', `[TTS] 解析错误: ${normalizeError(e).message}`, this.deviceId);
      return null;
    }
  }

  async _sendAudioToDevice(audioData: Buffer) {
    const deviceBot = this.AgentRuntime[this.deviceId] as DeviceBotLike | undefined;
    if (!deviceBot || !audioData || audioData.length === 0) return;

    const sr = Number(this.config.sampleRate || 16000);
    const chunkMs = Math.max(5, Math.min(512, Number(this.config.chunkMs || 40)));
    const bytesPerMs = (sr * 2) / 1000;
    const chunkBytes = Math.max(2, Math.floor((bytesPerMs * chunkMs) / 2) * 2);
    const delayMs = Math.max(0, Number(this.config.chunkDelayMs ?? 0));

    if (this.sessionStartTime === null) {
      this.sessionStartTime = Date.now();
      this.audioChunkCount = 0;
    }
    for (let offset = 0; offset < audioData.length; offset += chunkBytes) {
      const slice = Buffer.from(audioData.subarray(offset, Math.min(offset + chunkBytes, audioData.length)));
      // Node ≥26 Buffer#toHex；@types/node 可能尚未声明
      const hex = (slice as Buffer & { toHex: () => string }).toHex();
      this.audioChunkCount++;
      try {
        if (deviceBot.sendAudioChunk && typeof deviceBot.sendAudioChunk === 'function') {
          await deviceBot.sendAudioChunk(hex);
        } else {
          RuntimeUtil.makeLog('warn', `[TTS] sendAudioChunk 不可用`, this.deviceId);
        }
      } catch (e: unknown) {
        RuntimeUtil.makeLog('error', `[TTS] 发送失败: ${normalizeError(e).message}`, this.deviceId);
      }
      if (delayMs > 0) await waitMs(delayMs);
    }
  }

  async _ensureConnected() {
    if (this.connected) return;

    if (this.connecting) {
      const waitSignal = AbortSignal.timeout(3000);
      while (!this.connected) {
        try {
          await waitMs(30, waitSignal);
        } catch {
          throw new Error('TTS连接超时');
        }
      }
      return;
    }

    this.connecting = true;

    try {
      await new Promise<void>((resolve, reject) => {
        const connectSignal = AbortSignal.timeout(8000);
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          this.connecting = false;
          reject(err);
        };
        const ok = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const onAbort = () => fail(new Error('TTS连接超时'));
        connectSignal.addEventListener('abort', onAbort, { once: true });

        try {
          const ws = new WebSocket(this.config.wsUrl, {
            headers: this._headers(),
            handshakeTimeout: 8000,
          }) as WsSocket;

          this.ws = ws;

          ws.on('open', () => {
            RuntimeUtil.makeLog('info', `⚡ [TTS] WebSocket握手成功`, this.deviceId);

            const startConnFrame = this._buildEventFrame(TTS_EVENTS.START_CONNECTION, null, {});
            ws.send(startConnFrame);
          });

          ws.on('upgrade', (response: unknown) => {
            const headers = (response as { headers?: Record<string, string | string[] | undefined> })?.headers;
            const logId = headers?.['x-tt-logid'];
            if (logId) {
              const id = Array.isArray(logId) ? String(logId[0] ?? '') : String(logId);
              RuntimeUtil.makeLog('info', `[TTS] X-Tt-Logid: ${id}`, this.deviceId);
            }
          });

          ws.on('message', (buf: unknown) => {
            const raw = toBuffer(buf);
            if (!raw) return;
            const msg = this._parse(raw);

            if (!msg) return;

            if (msg.type === 'error') {
              RuntimeUtil.makeLog('error', `❌ [TTS错误] ${msg.errorCode}: ${msg.errorMessage}`, this.deviceId);
              connectSignal.removeEventListener('abort', onAbort);
              fail(new Error(msg.errorMessage));
              return;
            }

            if (msg.type === 'event') {
              this._handleEvent(msg, connectSignal, onAbort, ok, fail);
            }

            if (msg.type === 'audio') {
              this.totalAudioBytes += msg.data.length;
              const data = msg.data;
              this._audioSendPromise = this._audioSendPromise
                .then(() => this._sendAudioToDevice(data))
                .catch((e: unknown) =>
                  RuntimeUtil.makeLog('error', `[TTS] 发送音频失败: ${normalizeError(e).message}`, this.deviceId),
                );
            }
          });

          ws.on('error', (err: unknown) => {
            connectSignal.removeEventListener('abort', onAbort);
            RuntimeUtil.makeLog('error', `❌ [TTS] WebSocket错误: ${normalizeError(err).message}`, this.deviceId);
            this.connected = false;
            this.connecting = false;
            fail(normalizeError(err));
          });

          ws.on('close', (code: unknown) => {
            RuntimeUtil.makeLog('info', `✓ [TTS] WebSocket关闭 (code=${code})`, this.deviceId);
            this.connected = false;
            this.connecting = false;
            this.sessionActive = false;
          });
        } catch (e: unknown) {
          connectSignal.removeEventListener('abort', onAbort);
          fail(normalizeError(e));
        }
      });
    } catch (e: unknown) {
      this.connecting = false;
      throw normalizeError(e);
    }
  }

  _handleEvent(
    msg: Extract<ParsedTtsMessage, { type: 'event' }>,
    connectSignal: AbortSignal,
    onAbort: () => void,
    resolve: () => void,
    reject: (err: Error) => void,
  ) {
    switch (msg.event) {
      case TTS_EVENTS.CONNECTION_STARTED:
        connectSignal.removeEventListener('abort', onAbort);
        this.connected = true;
        this.connecting = false;
        this.connectionId =
          msg.connectionId ||
          (typeof msg.payload.connection_id === 'string' ? msg.payload.connection_id : null) ||
          'unknown';
        RuntimeUtil.makeLog('info', `✅ [TTS] 连接已建立 (conn_id=${this.connectionId})`, this.deviceId);
        resolve();
        break;

      case TTS_EVENTS.CONNECTION_FAILED: {
        connectSignal.removeEventListener('abort', onAbort);
        this.connecting = false;
        const failMsg =
          typeof msg.payload.message === 'string' ? msg.payload.message : 'TTS connection failed';
        RuntimeUtil.makeLog('error', `❌ [TTS] 连接失败: ${failMsg}`, this.deviceId);
        reject(new Error(failMsg));
        break;
      }

      case TTS_EVENTS.SESSION_STARTED:
        this.sessionActive = true;
        this.totalAudioBytes = 0;
        this.audioChunkCount = 0;
        this.lastChunkTime = null;
        this.sessionStartTime = null;
        RuntimeUtil.makeLog('info', `⚡ [TTS] Session已启动 (${msg.sessionId})`, this.deviceId);
        break;

      case TTS_EVENTS.SESSION_FINISHED:
        this.sessionActive = false;
        {
          const sessionDuration = this.sessionStartTime
            ? ((Date.now() - this.sessionStartTime) / 1000).toFixed(2)
            : 'N/A';
          RuntimeUtil.makeLog(
            'info',
            `✅ [TTS] Session已结束: 总块数=${this.audioChunkCount}, 总字节=${this.totalAudioBytes}, Session耗时=${sessionDuration}s`,
            this.deviceId,
          );
        }
        this.audioChunkCount = 0;
        this.lastChunkTime = null;
        this.sessionStartTime = null;
        setImmediate(() => {
          this._audioSendPromise
            .then(() => {
              if (this._sessionTimeout) {
                clearTimeout(this._sessionTimeout);
                this._sessionTimeout = null;
              }
              if (this._sessionResolve) {
                this._sessionResolve();
                this._sessionResolve = null;
              }
            })
            .catch(() => {
              if (this._sessionTimeout) {
                clearTimeout(this._sessionTimeout);
                this._sessionTimeout = null;
              }
              if (this._sessionResolve) {
                this._sessionResolve();
                this._sessionResolve = null;
              }
            });
        });
        break;

      case TTS_EVENTS.TTS_SENTENCE_START: {
        const resParams = msg.payload.res_params as { text?: string } | undefined;
        RuntimeUtil.makeLog('debug', `[TTS] 句子开始: ${resParams?.text || ''}`, this.deviceId);
        break;
      }

      case TTS_EVENTS.TTS_SENTENCE_END:
        RuntimeUtil.makeLog('debug', `[TTS] 句子结束`, this.deviceId);
        break;
    }
  }

  async synthesize(text: string, options: SynthesizeOptions = {}) {
    if (!text || text.trim() === '') {
      RuntimeUtil.makeLog('warn', '[TTS] 文本为空', this.deviceId);
      return false;
    }

    try {
      await this._ensureConnected();

      this.currentSessionId = uuidv4();

      const voiceType = options.voiceType || this.config.voiceType;
      const encoding = options.encoding || this.config.encoding;
      const sampleRate = options.sampleRate || this.config.sampleRate;
      const speechRate = options.speechRate ?? this.config.speechRate;
      const loudnessRate = options.loudnessRate ?? this.config.loudnessRate;
      const emotion = options.emotion || this.config.emotion;
      const audioParamsExtra = options.audioParams || {};
      const reqParamsExtra = options.reqParams || {};

      const sessionPayload = {
        user: {
          uid: this.deviceId,
        },
        req_params: {
          speaker: voiceType,
          audio_params: {
            format: String(encoding || 'pcm').toLowerCase(),
            sample_rate: sampleRate,
            speech_rate: speechRate,
            loudness_rate: loudnessRate,
            emotion,
            ...audioParamsExtra,
          },
          ...reqParamsExtra,
        },
      };

      const startSessionFrame = this._buildEventFrame(
        TTS_EVENTS.START_SESSION,
        this.currentSessionId,
        sessionPayload,
      );
      this.ws!.send(startSessionFrame);

      const taskPayload = {
        req_params: {
          text,
        },
      };

      const taskFrame = this._buildEventFrame(TTS_EVENTS.TASK_REQUEST, this.currentSessionId, taskPayload);
      this.ws!.send(taskFrame);

      RuntimeUtil.makeLog(
        'info',
        `⚡ [TTS] 开始合成: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
        this.deviceId,
      );

      const finishFrame = this._buildEventFrame(TTS_EVENTS.FINISH_SESSION, this.currentSessionId, {});
      this.ws!.send(finishFrame);

      return await new Promise<void>((resolve) => {
        this._sessionResolve = resolve;
        this._sessionTimeout = setTimeout(() => {
          if (this._sessionResolve) {
            this._sessionResolve();
            this._sessionResolve = null;
          }
          this._sessionTimeout = null;
        }, 30000);
      });
    } catch (e: unknown) {
      RuntimeUtil.makeLog('error', `❌ [TTS] 合成失败: ${normalizeError(e).message}`, this.deviceId);
      return;
    }
  }

  async waitAudioSent() {
    await this._audioSendPromise;
  }

  async destroy() {
    this.totalAudioBytes = 0;
    this.audioChunkCount = 0;
    this.lastChunkTime = null;
    this.sessionStartTime = null;

    if (this._sessionTimeout) {
      clearTimeout(this._sessionTimeout);
      this._sessionTimeout = null;
    }
    this._sessionResolve = null;

    if (this.ws) {
      try {
        if (this.connected) {
          const finishConnFrame = this._buildEventFrame(TTS_EVENTS.FINISH_CONNECTION, null, {});
          this.ws.send(finishConnFrame);
          await waitMs(100);
        }

        if (this.ws.readyState === 1) {
          this.ws.close(1000, 'client destroy');
        } else {
          this.ws.terminate();
        }
      } catch {
        // 忽略错误
      }
      this.ws = null;
    }

    this.connected = false;
    this.connecting = false;
    this.sessionActive = false;
    this.currentSessionId = null;
    this.connectionId = null;
  }
}
