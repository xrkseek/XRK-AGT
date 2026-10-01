/**
 * 火山引擎ASR客户端
 * 实现语音识别功能，支持实时流式识别
 */

// @ts-expect-error no @types/ws
import WebSocket from 'ws';
import zlib from 'node:zlib';
import { v4 as uuidv4 } from 'uuid';
import RuntimeUtil from '#utils/runtime-util.js';
import { buildVolcengineSpeechHeaders } from '#utils/volcengine-speech-headers.js';
import { normalizeError } from '#utils/normalize-error.js';

type AsrConfig = Record<string, unknown> & {
  wsUrl?: string;
  format?: string;
  codec?: string;
  sampleRate?: number;
  bits?: number;
  channel?: number;
  channels?: number;
  modelName?: string;
  enableItn?: unknown;
  enablePunc?: unknown;
  enableDdc?: unknown;
  showUtterances?: unknown;
  resultType?: unknown;
  enableAccelerateText?: unknown;
  accelerateScore?: unknown;
  endWindowSize?: unknown;
  forceToSpeechTime?: unknown;
  idleCloseMs?: number;
  wsPingIntervalMs?: number;
  wsPongTimeoutMs?: number;
  wsMaxReconnectAttempts?: number;
  wsReconnectDelayMs?: number;
  finalResultTimeoutMs?: number;
  resourceId?: unknown;
  apiKey?: unknown;
  xApiKey?: unknown;
  appKey?: unknown;
  accessKey?: unknown;
};

type AgentRuntimeLike = {
  em: (name: string, data: Record<string, unknown>) => unknown;
  [deviceId: string]: unknown;
};

type AudioInfo = {
  format?: string;
  codec?: string;
  rate?: number;
  bits?: number;
  channel?: number;
  sample_rate?: number;
  channels?: number;
  modelName?: string;
  audioOptions?: Record<string, unknown>;
  requestOptions?: Record<string, unknown>;
};

type UtteranceState = {
  sessionId: string;
  startedAt: number;
  ending: boolean;
  _cleanupTimer?: ReturnType<typeof setTimeout> | null;
};

type ParsedAsrMessage =
  | { type: 'error'; errorCode: number; errorMessage: string; isLast?: undefined; result?: undefined }
  | { type: 'result'; result: Record<string, unknown>; isLast: boolean; errorCode?: undefined; errorMessage?: undefined };

/** Minimal surface of `ws` WebSocket used by this client (no @types/ws). */
type WsSocket = {
  readyState: number;
  ping: () => void;
  terminate: () => void;
  close: (code?: number, reason?: string) => void;
  send: (data: Buffer) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
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

export default class VolcengineASRClient {
  deviceId: string;
  config: AsrConfig;
  AgentRuntime: AgentRuntimeLike;
  connectId: string;

  _timeoutEmittedSet = new Set<string>();
  _timeoutEmittedQueue: string[] = [];
  _timeoutEmittedMax = 64;
  ws: WsSocket | null = null;
  connected = false;
  connecting = false;
  sequence = 1;
  currentUtterance: UtteranceState | null = null;
  _lastIntermediateText = '';
  lastMessageAt = 0;
  lastAudioAt = 0;
  logId: string | null = null;
  _idleTimer: ReturnType<typeof setTimeout> | null = null;
  _pingTimer: ReturnType<typeof setInterval> | null = null;
  _pongTimer: ReturnType<typeof setTimeout> | null = null;
  reconnectAttempts = 0;
  _closingForRotate = false;
  performanceMetrics: {
    firstResultTime: number | null;
    audioStartTime: number | null;
  } = {
    firstResultTime: null,
    audioStartTime: null,
  };

  constructor(deviceId: string, config: AsrConfig = {}, AgentRuntime: AgentRuntimeLike) {
    this.deviceId = deviceId;
    this.config = config;
    this.AgentRuntime = AgentRuntime;
    this.connectId = uuidv4();
  }

  /** 生成WebSocket连接头部（新控制台 X-Api-Key；旧控制台 App-Key + Access-Key） */
  _headers() {
    return buildVolcengineSpeechHeaders(this.config, { connectId: this.connectId });
  }

  _emitAsrTimeoutOnce(sessionId: string | null | undefined, reason = '') {
    if (!sessionId) return;
    if (this._timeoutEmittedSet.has(sessionId)) return;
    this._timeoutEmittedSet.add(sessionId);
    this._timeoutEmittedQueue.push(sessionId);
    if (this._timeoutEmittedQueue.length > this._timeoutEmittedMax) {
      const old = this._timeoutEmittedQueue.shift();
      if (old) this._timeoutEmittedSet.delete(old);
    }
    this.AgentRuntime.em('device.asr_timeout', {
      post_type: 'device',
      event_type: 'asr_timeout',
      device_id: this.deviceId,
      session_id: sessionId,
      self_id: this.deviceId,
      time: Math.floor(Date.now() / 1000),
      reason,
    });
  }

  /** 构建协议头部（4字节） */
  _protoHeader(messageType: number, messageFlags: number, serialization: number, compression: number) {
    const header = Buffer.alloc(4);
    header[0] = 0x11;
    header[1] = (messageType << 4) | messageFlags;
    header[2] = (serialization << 4) | compression;
    header[3] = 0x00;
    return header;
  }

  /** 构建完整客户端请求（带音频配置） */
  _fullClientRequest(audioInfo: AudioInfo = {}) {
    const runtimeConfig = this.config || {};

    const audioFormat = audioInfo?.format || runtimeConfig.format || 'pcm';
    const audioCodec = audioInfo?.codec || runtimeConfig.codec || 'raw';
    const rate = audioInfo?.rate || runtimeConfig.sampleRate || 16000;
    const bits = audioInfo?.bits || runtimeConfig.bits || 16;
    const channel = audioInfo?.channel || runtimeConfig.channel || runtimeConfig.channels || 1;
    const audioOptions = audioInfo?.audioOptions || {};

    const modelName = audioInfo?.modelName || runtimeConfig.modelName || 'bigmodel';
    const requestOptions = audioInfo?.requestOptions || {};

    const payload = {
      user: {
        uid: this.deviceId,
        platform: 'ESP32-S3',
      },
      audio: {
        format: audioFormat,
        codec: audioCodec,
        rate,
        bits,
        channel,
        ...audioOptions,
      },
      request: {
        model_name: modelName,
        enable_itn: runtimeConfig.enableItn,
        enable_punc: runtimeConfig.enablePunc,
        enable_ddc: runtimeConfig.enableDdc,
        show_utterances: runtimeConfig.showUtterances,
        result_type: runtimeConfig.resultType,
        enable_accelerate_text: runtimeConfig.enableAccelerateText,
        accelerate_score: runtimeConfig.accelerateScore,
        end_window_size: runtimeConfig.endWindowSize,
        force_to_speech_time: runtimeConfig.forceToSpeechTime,
        ...requestOptions,
      },
    };

    const json = JSON.stringify(payload);
    const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
    const header = this._protoHeader(0x1, 0x0, 0x1, 0x1);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(gz.length, 0);

    return Buffer.concat([header, size, gz]);
  }

  /** 构建纯音频请求 */
  _audioOnlyRequest(audioBuf: Buffer, isLast = false) {
    const gz = zlib.gzipSync(audioBuf);
    const flags = isLast ? 0x2 : 0x1;
    const header = this._protoHeader(0x2, flags, 0x0, 0x1);
    const payloadSize = Buffer.alloc(4);
    payloadSize.writeUInt32BE(gz.length, 0);

    if (!isLast) {
      this.sequence++;
      if (this.sequence > 0xffffffff) {
        this.sequence = 1;
      }
      const seq = Buffer.alloc(4);
      seq.writeUInt32BE(this.sequence, 0);
      return Buffer.concat([header, seq, payloadSize, gz]);
    }

    return Buffer.concat([header, payloadSize, gz]);
  }

  /** 解析服务器返回的数据 */
  _parse(data: Buffer): ParsedAsrMessage | null {
    try {
      if (!data || data.length < 4) return null;

      const messageType = (data[1]! >> 4) & 0x0f;
      const messageFlags = data[1]! & 0x0f;
      const compression = data[2]! & 0x0f;

      if (messageType === 0xf) {
        const errCode = data.readUInt32BE(4);
        const errSize = data.readUInt32BE(8);
        const msg = data.subarray(12, 12 + errSize).toString('utf-8');
        return { type: 'error', errorCode: errCode, errorMessage: msg };
      }

      if (messageType === 0x9) {
        let offset = 4;
        if (messageFlags === 0x1 || messageFlags === 0x3) {
          offset += 4;
        }
        const size = data.readUInt32BE(offset);
        offset += 4;
        let payload = data.subarray(offset, offset + size);

        if (compression === 0x1) {
          payload = zlib.gunzipSync(payload);
        }

        const result = JSON.parse(payload.toString('utf-8')) as Record<string, unknown>;
        const isLast = messageFlags === 0x3 || messageFlags === 0x2;

        return { type: 'result', result, isLast };
      }

      return null;
    } catch {
      return null;
    }
  }

  _startPingTimer() {
    if (!this.config.wsPingIntervalMs) return;
    this._clearPingTimer();

    this._pingTimer = setInterval(() => {
      try {
        if (this.ws && this.connected) {
          RuntimeUtil.makeLog('debug', `[ASR] 发送 Ping`, this.deviceId);
          this.ws.ping();
          this._startPongTimer();
        }
      } catch {
        // 忽略错误
      }
    }, this.config.wsPingIntervalMs || 30000);
  }

  _clearPingTimer() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _startPongTimer() {
    this._clearPongTimer();
    this._pongTimer = setTimeout(() => {
      RuntimeUtil.makeLog('warn', `[ASR] Pong超时，断开连接`, this.deviceId);
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {
          // 忽略错误
        }
      }
    }, this.config.wsPongTimeoutMs || 10000);
  }

  _clearPongTimer() {
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  /** 确保WebSocket已连接（连接等待用 AbortSignal.timeout） */
  async _ensureConnected() {
    if (this.connected) return;

    if (this.connecting) {
      const waitSignal = AbortSignal.timeout(3000);
      while (!this.connected) {
        try {
          await waitMs(30, waitSignal);
        } catch {
          throw new Error('连接超时');
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
        const onAbort = () => fail(new Error('连接超时'));
        connectSignal.addEventListener('abort', onAbort, { once: true });

        try {
          this.connectId = uuidv4();
          const ws = new WebSocket(this.config.wsUrl, {
            headers: this._headers(),
            handshakeTimeout: 8000,
          }) as WsSocket;

          this.ws = ws;

          ws.on('open', () => {
            connectSignal.removeEventListener('abort', onAbort);
            this.connected = true;
            this.connecting = false;
            this.lastMessageAt = Date.now();
            this.reconnectAttempts = 0;

            RuntimeUtil.makeLog('info', `⚡ [ASR] WebSocket已连接`, this.deviceId);
            this._startPingTimer();
            ok();
          });

          ws.on('upgrade', (response: unknown) => {
            const headers = (response as { headers?: Record<string, string | string[] | undefined> })?.headers;
            const logId = headers?.['x-tt-logid'];
            this.logId = Array.isArray(logId) ? String(logId[0] ?? '') : logId != null ? String(logId) : null;
          });

          ws.on('message', (buf: unknown) => {
            this.lastMessageAt = Date.now();
            let raw: Buffer;
            if (Buffer.isBuffer(buf)) {
              raw = buf;
            } else if (buf instanceof ArrayBuffer) {
              raw = Buffer.from(new Uint8Array(buf));
            } else if (ArrayBuffer.isView(buf)) {
              raw = Buffer.from(buf as Uint8Array);
            } else if (typeof buf === 'string') {
              raw = Buffer.from(buf);
            } else {
              return;
            }
            const msg = this._parse(raw);

            if (!msg) return;

            RuntimeUtil.makeLog(
              'debug',
              `[ASR] 收到消息 type=${msg.type} isLast=${msg.isLast ?? '-'}`,
              this.deviceId,
            );

            if (msg.type === 'error') {
              this._handleError(msg);
              return;
            }

            if (msg.type === 'result') {
              if (!this.performanceMetrics.firstResultTime && this.performanceMetrics.audioStartTime) {
                this.performanceMetrics.firstResultTime = Date.now() - this.performanceMetrics.audioStartTime;
                RuntimeUtil.makeLog(
                  'info',
                  `⚡ [ASR性能] 首字返回: ${this.performanceMetrics.firstResultTime}ms`,
                  this.deviceId,
                );
              }

              this._handleResult(msg.result, msg.isLast);

              if (msg.isLast) {
                if (this.currentUtterance) {
                  const start = this.performanceMetrics.audioStartTime ?? Date.now();
                  const totalTime = Date.now() - start;
                  RuntimeUtil.makeLog('info', `⚡ [ASR性能] 总处理时间: ${totalTime}ms`, this.deviceId);
                  if (this.currentUtterance._cleanupTimer) {
                    clearTimeout(this.currentUtterance._cleanupTimer);
                    this.currentUtterance._cleanupTimer = null;
                  }
                }
                this.currentUtterance = null;
                this._armIdleTimer();
              }
            }
          });

          ws.on('pong', () => {
            this._clearPongTimer();
            this.lastMessageAt = Date.now();
            RuntimeUtil.makeLog('debug', `[ASR] 收到 Pong`, this.deviceId);
          });

          ws.on('error', (err: unknown) => {
            connectSignal.removeEventListener('abort', onAbort);
            const error = normalizeError(err);

            if (error.message.includes('401')) {
              RuntimeUtil.makeLog(
                'error',
                `❌ [ASR] 认证失败(401): 请检查 apiKey（新控制台）或 appKey/accessKey（旧控制台）与 resourceId`,
                this.deviceId,
              );
            } else {
              RuntimeUtil.makeLog('error', `❌ [ASR] WebSocket错误: ${error.message}`, this.deviceId);
            }

            this.connected = false;
            this.connecting = false;
            this.currentUtterance = null;
            this._clearIdleTimer();
            this._clearPingTimer();
            this._clearPongTimer();
            fail(error);
          });

          ws.on('close', (code: unknown) => {
            if (this.ws !== ws) return;
            const closeCode = typeof code === 'number' ? code : Number(code) || 0;
            RuntimeUtil.makeLog('info', `✓ [ASR] WebSocket关闭 (code=${closeCode})`, this.deviceId);
            this.connected = false;
            this.connecting = false;

            if (this.currentUtterance && !this._closingForRotate) {
              const u = this.currentUtterance;
              if (!u.ending) {
                const sid = u.sessionId;
                if (u._cleanupTimer) {
                  clearTimeout(u._cleanupTimer);
                  u._cleanupTimer = null;
                }
                this.currentUtterance = null;
                this._emitAsrTimeoutOnce(sid, `ws_close:${closeCode}`);
              }
            }

            this._clearIdleTimer();
            this._clearPingTimer();
            this._clearPongTimer();

            if (closeCode !== 1000 && this.reconnectAttempts < (this.config.wsMaxReconnectAttempts || 5)) {
              this._scheduleReconnect();
            }
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

  _scheduleReconnect() {
    this.reconnectAttempts++;
    const delay = Math.min((this.config.wsReconnectDelayMs || 2000) * this.reconnectAttempts, 10000);

    RuntimeUtil.makeLog(
      'info',
      `🔄 [ASR] 将在${delay}ms后重连（第${this.reconnectAttempts}次）`,
      this.deviceId,
    );

    setTimeout(() => {
      if (!this.connected && !this.connecting) {
        this._ensureConnected().catch((e: unknown) => {
          RuntimeUtil.makeLog('error', `❌ [ASR] 重连失败: ${normalizeError(e).message}`, this.deviceId);
        });
      }
    }, delay);
  }

  _handleError(msg: Extract<ParsedAsrMessage, { type: 'error' }>) {
    const errorCode = msg.errorCode;

    if (errorCode === 45000081) {
      const idleMs = this.lastMessageAt ? Date.now() - this.lastMessageAt : -1;
      const sessionId = this.currentUtterance?.sessionId ?? null;
      RuntimeUtil.makeLog('warn', `⚠️ [ASR] 服务器超时，清理状态`, this.deviceId);
      RuntimeUtil.makeLog(
        'debug',
        `[ASR] 超时上下文: lastMessageAt距今=${idleMs}ms sessionId=${sessionId} errorMessage=${msg.errorMessage || ''}`,
        this.deviceId,
      );
      const last = this._lastIntermediateText?.trim();
      if (last && this.currentUtterance) {
        this.AgentRuntime.em('device.asr_result', {
          post_type: 'device',
          event_type: 'asr_result',
          device_id: this.deviceId,
          session_id: this.currentUtterance.sessionId,
          text: last,
          is_final: true,
          duration: 0,
          result: null,
          self_id: this.deviceId,
          time: Math.floor(Date.now() / 1000),
        });
      }
      this._lastIntermediateText = '';
      this._emitAsrTimeoutOnce(sessionId, `server_error:${errorCode}`);
    } else if (errorCode === 45000000) {
      this.sequence = 1;
    } else {
      RuntimeUtil.makeLog('error', `❌ [ASR错误] ${errorCode}: ${msg.errorMessage}`, this.deviceId);
    }

    if (this.currentUtterance) {
      this.currentUtterance = null;
    }
    this._armIdleTimer();
  }

  _handleResult(result: Record<string, unknown>, isLast: boolean) {
    try {
      const nested = result?.result as { text?: string } | undefined;
      const text = nested?.text || (typeof result?.text === 'string' ? result.text : '') || '';
      const audioInfo = result?.audio_info as { duration?: number } | undefined;
      const duration = audioInfo?.duration || 0;

      if (text) {
        const sessionId = this.currentUtterance?.sessionId;
        if (!isLast) this._lastIntermediateText = text;
        else this._lastIntermediateText = '';

        if (isLast) {
          RuntimeUtil.makeLog('debug', `[ASR] 最终: "${text}"`, this.deviceId);
        } else {
          RuntimeUtil.makeLog('debug', `[ASR] 中间: "${text}"`, this.deviceId);
        }

        if (this.AgentRuntime[this.deviceId]) {
          this.AgentRuntime.em('device.asr_result', {
            post_type: 'device',
            event_type: 'asr_result',
            device_id: this.deviceId,
            session_id: sessionId || null,
            text,
            is_final: !!isLast,
            duration,
            result: nested || result,
            self_id: this.deviceId,
            time: Math.floor(Date.now() / 1000),
          });
        }
      }
    } catch (e: unknown) {
      RuntimeUtil.makeLog('error', `❌ [ASR] 处理结果失败: ${normalizeError(e).message}`, this.deviceId);
    }
  }

  _armIdleTimer() {
    const idleCloseMs = Number(this.config.idleCloseMs ?? 0);
    if (idleCloseMs > 0) {
      this._clearIdleTimer();
      this._idleTimer = setTimeout(() => {
        if (this.ws && this.connected && !this.currentUtterance) {
          RuntimeUtil.makeLog('info', `✓ [ASR] 空闲超时，关闭连接`, this.deviceId);
          this.ws.close();
        }
      }, idleCloseMs);
    }
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  async beginUtterance(sessionId: string, audioInfo: AudioInfo = {}) {
    if (this.currentUtterance && !this.currentUtterance.ending) {
      try {
        await this.endUtterance();
      } catch {
        /* ignore */
      }
    }
    if (this.ws) {
      this._closingForRotate = true;
      try {
        await new Promise<void>((resolve) => {
          const w = this.ws;
          if (!w) {
            resolve();
            return;
          }
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          const rotateSignal = AbortSignal.timeout(1000);
          rotateSignal.addEventListener('abort', finish, { once: true });
          try {
            w.once('close', () => finish());
            if (w.readyState === 1) w.close(1000, 'rotate utterance');
            else w.terminate();
          } catch {
            finish();
          }
        });
      } catch {
        // ignore
      } finally {
        this._closingForRotate = false;
        this.ws = null;
        this.connected = false;
        this.connecting = false;
      }
    }

    await this._ensureConnected();
    this._clearIdleTimer();

    this.performanceMetrics = {
      firstResultTime: null,
      audioStartTime: Date.now(),
    };

    this.currentUtterance = {
      sessionId,
      startedAt: Date.now(),
      ending: false,
    };
    this._lastIntermediateText = '';
    this.sequence = 1;

    const fullReq = this._fullClientRequest({
      rate: audioInfo?.sample_rate || 16000,
      bits: audioInfo?.bits || 16,
      channel: audioInfo?.channels || 1,
      format: audioInfo?.format,
      codec: audioInfo?.codec,
      modelName: audioInfo?.modelName,
    });

    this.ws!.send(fullReq);
    RuntimeUtil.makeLog('info', `⚡ [ASR会话] 开始: ${sessionId}`, this.deviceId);
  }

  sendAudio(audioBuf: Buffer) {
    if (!this.ws || !this.connected) return false;
    if (!this.currentUtterance || this.currentUtterance.ending) return false;
    if (!audioBuf || audioBuf.length === 0) return true;

    try {
      const frame = this._audioOnlyRequest(audioBuf, false);
      this.ws.send(frame);
      this.lastAudioAt = Date.now();
      return true;
    } catch (e: unknown) {
      RuntimeUtil.makeLog('error', `❌ [ASR] 发送音频失败: ${normalizeError(e).message}`, this.deviceId);
      return false;
    }
  }

  async endUtterance() {
    if (!this.currentUtterance || this.currentUtterance.ending) return false;

    this.currentUtterance.ending = true;

    if (!this.ws || !this.connected) {
      this.currentUtterance = null;
      this._armIdleTimer();
      return false;
    }

    try {
      const last = this._audioOnlyRequest(Buffer.alloc(0), true);
      this.ws.send(last);

      const sessionId = this.currentUtterance.sessionId;
      RuntimeUtil.makeLog('info', `✓ [ASR会话] 结束: ${sessionId}`, this.deviceId);

      const cleanupTimer = setTimeout(() => {
        if (this.currentUtterance && this.currentUtterance.sessionId === sessionId) {
          RuntimeUtil.makeLog('warn', `[ASR] 会话 ${sessionId} 超时未收到最终结果，强制清理`, this.deviceId);
          if (this.currentUtterance._cleanupTimer) {
            clearTimeout(this.currentUtterance._cleanupTimer);
            this.currentUtterance._cleanupTimer = null;
          }
          this.currentUtterance = null;
          this._emitAsrTimeoutOnce(sessionId, 'no_final_result');
        }
      }, this.config.finalResultTimeoutMs || 8000);

      if (this.currentUtterance) {
        this.currentUtterance._cleanupTimer = cleanupTimer;
      }

      this._armIdleTimer();
      return true;
    } catch (e: unknown) {
      RuntimeUtil.makeLog('error', `❌ [ASR] 结束失败: ${normalizeError(e).message}`, this.deviceId);
      this.currentUtterance = null;
      this._armIdleTimer();
      return false;
    }
  }

  async destroy() {
    this._clearIdleTimer();
    this._clearPingTimer();
    this._clearPongTimer();

    if (this.currentUtterance?._cleanupTimer) {
      clearTimeout(this.currentUtterance._cleanupTimer);
      this.currentUtterance._cleanupTimer = null;
    }

    if (this.currentUtterance && !this.currentUtterance.ending) {
      try {
        await this.endUtterance();
      } catch {
        // 忽略错误
      }
    }

    this.currentUtterance = null;
    this.sequence = 1;
    this.performanceMetrics = {
      firstResultTime: null,
      audioStartTime: null,
    };

    if (this.ws) {
      try {
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
    this.reconnectAttempts = 0;
  }
}
