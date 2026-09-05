// @ts-nocheck
/**
 * 火山引擎TTS客户端（V3双向流式协议）
 * 实现文本转语音功能，支持实时流式合成。
 * 流式/Opus 场景必须请求 format=pcm，否则服务端可能返回 wav（多次 header）或 mp3，导致下游当 PCM 处理出错。
 */

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
    TTS_RESPONSE: 352
};

export default class VolcengineTTSClient {
    ws = null;
    connected = false;
    connecting = false;
    connectionId = null;
    currentSessionId = null;
    sessionActive = false;
    totalAudioBytes = 0;
    audioChunkCount = 0;
    lastChunkTime = null;
    sessionStartTime = null;
    _sessionResolve = null;
    _sessionTimeout = null;
    /** 串行化下发：保证多段 audio 按序送设备，避免与 xiaozhi Opus 编码/流控 乱序导致丢包 */
    _audioSendPromise = Promise.resolve();

    /**
     * @param {string} deviceId
     * @param {Object} config
     * @param {Object} AgentRuntime
     */
    constructor(deviceId, config, AgentRuntime) {
        this.deviceId = deviceId;
        this.config = config;
        this.AgentRuntime = AgentRuntime;
    }

    /**
     * 生成WebSocket连接头部（新控制台 X-Api-Key；旧控制台 App-Key + Access-Key）
     * @returns {Object} 请求头对象
     * @private
     */
    _headers() {
        return buildVolcengineSpeechHeaders(this.config, { connectId: uuidv4() });
    }

    /**
     * 构建协议头部（4字节）
     * @param {number} messageType - 消息类型
     * @param {number} messageFlags - 消息标志
     * @param {number} serialization - 序列化方式
     * @param {number} compression - 压缩方式
     * @returns {Buffer} 协议头Buffer
     * @private
     */
    _protoHeader(messageType, messageFlags, serialization, compression) {
        const header = Buffer.alloc(4);
        header[0] = 0x11;
        header[1] = (messageType << 4) | messageFlags;
        header[2] = (serialization << 4) | compression;
        header[3] = 0x00;
        return header;
    }

    /**
     * 构建事件帧
     * @param {number} event - 事件类型
     * @param {string|null} sessionId - 会话ID（可选）
     * @param {Object} payload - 负载数据
     * @returns {Buffer} 事件帧Buffer
     * @private
     */
    _buildEventFrame(event, sessionId = null, payload = {}) {
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

    /**
     * 解析服务器返回的数据帧
     * @param {Buffer} data - 原始数据
     * @returns {Object|null} 解析结果
     * @private
     */
    _parse(data) {
        try {
            if (!data || data.length < 4) return null;

            const messageType = (data[1] >> 4) & 0x0F;
            const messageFlags = data[1] & 0x0F;
            const serialization = (data[2] >> 4) & 0x0F;
            const compression = data[2] & 0x0F;

            let offset = 4;

            // 错误帧
            if (messageType === 0xF) {
                const errCode = data.readInt32BE(offset);
                offset += 4;
                const errLen = data.readUInt32BE(offset);
                offset += 4;
                const errMsg = data.slice(offset, offset + errLen).toString('utf-8');
                return { type: 'error', errorCode: errCode, errorMessage: errMsg };
            }

            // 音频帧
            if (messageType === 0xB) {
                const event = data.readInt32BE(offset);
                offset += 4;

                const sessionIdLen = data.readUInt32BE(offset);
                offset += 4;
                const sessionId = data.slice(offset, offset + sessionIdLen).toString('utf-8');
                offset += sessionIdLen;

                const audioLen = data.readUInt32BE(offset);
                offset += 4;
                const audioBuf = data.slice(offset, offset + audioLen);

                return {
                    type: 'audio',
                    event,
                    sessionId,
                    data: audioBuf
                };
            }

            // 事件帧
            if (messageFlags === 0x4) {
                const event = data.readInt32BE(offset);
                offset += 4;

                let connectionId = null;
                let sessionId = null;

                if (event >= 50 && event < 100) {
                    const connectionIdLen = data.readUInt32BE(offset);
                    offset += 4;
                    connectionId = data.slice(offset, offset + connectionIdLen).toString('utf-8');
                    offset += connectionIdLen;
                } else if ((event >= 100 && event < 200) || (event >= 350 && event < 400)) {
                    const sessionIdLen = data.readUInt32BE(offset);
                    offset += 4;
                    sessionId = data.slice(offset, offset + sessionIdLen).toString('utf-8');
                    offset += sessionIdLen;
                }

                const payloadLen = data.readUInt32BE(offset);
                offset += 4;
                let payload = data.slice(offset, offset + payloadLen);

                if (compression === 0x1 && payload.length > 0) {
                    try {
                        payload = zlib.gunzipSync(payload);
                    } catch (gzipErr) {
                        RuntimeUtil.makeLog('warn', 
                            `[TTS] Gzip解压失败: ${gzipErr.message}`, 
                            this.deviceId
                        );
                    }
                }

                let payloadObj = {};
                if (serialization === 0x1 && payload.length > 0) {
                    try {
                        const payloadStr = payload.toString('utf-8');
                        payloadObj = JSON.parse(payloadStr);
                    } catch {
                        // 忽略解析错误
                    }
                }

                return {
                    type: 'event',
                    event,
                    connectionId,
                    sessionId,
                    payload: payloadObj
                };
            }

            return null;
        } catch (e) {
            RuntimeUtil.makeLog('error', `[TTS] 解析错误: ${e.message}`, this.deviceId);
            return null;
        }
    }

    async _sendAudioToDevice(audioData) {
        const deviceBot = this.AgentRuntime[this.deviceId];
        if (!deviceBot || !audioData || audioData.length === 0) return;
        
        const sr = this.config.sampleRate || 16000;
        const chunkMs = Math.max(5, Math.min(512, this.config.chunkMs || 40));
        const bytesPerMs = (sr * 2) / 1000;
        const chunkBytes = Math.max(2, Math.floor((bytesPerMs * chunkMs) / 2) * 2);
        const delayMs = Math.max(0, Number(this.config.chunkDelayMs ?? 0)); // 0 表示不做额外延迟
        
        if (this.sessionStartTime === null) {
            this.sessionStartTime = Date.now();
            this.audioChunkCount = 0;
        }
        for (let offset = 0; offset < audioData.length; offset += chunkBytes) {
            const slice = audioData.slice(offset, Math.min(offset + chunkBytes, audioData.length));
            const hex = slice.toHex();
            this.audioChunkCount++;
            try {
                if (deviceBot.sendAudioChunk && typeof deviceBot.sendAudioChunk === 'function') {
                    await deviceBot.sendAudioChunk(hex);
                } else {
                    RuntimeUtil.makeLog('warn', `[TTS] sendAudioChunk 不可用`, this.deviceId);
                }
            } catch (e) {
                RuntimeUtil.makeLog('error', `[TTS] 发送失败: ${e.message}`, this.deviceId);
            }
            if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        }
    }

    /**
     * 确保WebSocket已连接
     * @returns {Promise<void>}
     * @private
     */
    async _ensureConnected() {
        if (this.connected) return;

        if (this.connecting) {
            for (let i = 0; i < 100; i++) {
                await new Promise(r => setTimeout(r, 30));
                if (this.connected) return;
            }
            throw new Error('TTS连接超时');
        }

        this.connecting = true;

        try {
            await new Promise((resolve, reject) => {
                const connectTimeout = setTimeout(() => {
                    this.connecting = false;
                    reject(new Error('TTS连接超时'));
                }, 8000);

                try {
                    const ws = new WebSocket(this.config.wsUrl, {
                        headers: this._headers(),
                        handshakeTimeout: 8000
                    });

                    this.ws = ws;

                    ws.on('open', () => {
                        RuntimeUtil.makeLog('info', `⚡ [TTS] WebSocket握手成功`, this.deviceId);

                        const startConnFrame = this._buildEventFrame(TTS_EVENTS.START_CONNECTION, null, {});
                        ws.send(startConnFrame);
                    });

                    ws.on('upgrade', (response) => {
                        const logId = response.headers['x-tt-logid'];
                        if (logId) {
                            RuntimeUtil.makeLog('info', `[TTS] X-Tt-Logid: ${logId}`, this.deviceId);
                        }
                    });

                    ws.on('message', (buf) => {
                        const msg = this._parse(buf);

                        if (!msg) return;

                        if (msg.type === 'error') {
                            RuntimeUtil.makeLog('error',
                                `❌ [TTS错误] ${msg.errorCode}: ${msg.errorMessage}`,
                                this.deviceId
                            );
                            clearTimeout(connectTimeout);
                            this.connecting = false;
                            reject(new Error(msg.errorMessage));
                            return;
                        }

                        if (msg.type === 'event') {
                            this._handleEvent(msg, connectTimeout, resolve, reject);
                        }

                        if (msg.type === 'audio') {
                            this.totalAudioBytes += msg.data.length;
                            const data = msg.data;
                            this._audioSendPromise = this._audioSendPromise
                                .then(() => this._sendAudioToDevice(data))
                                .catch(e => RuntimeUtil.makeLog('error', `[TTS] 发送音频失败: ${e.message}`, this.deviceId));
                        }
                    });

                    ws.on('error', (err) => {
                        clearTimeout(connectTimeout);
                        RuntimeUtil.makeLog('error',
                            `❌ [TTS] WebSocket错误: ${normalizeError(err).message}`,
                            this.deviceId
                        );
                        this.connected = false;
                        this.connecting = false;
                        reject(err);
                    });

                    ws.on('close', (code) => {
                        RuntimeUtil.makeLog('info', `✓ [TTS] WebSocket关闭 (code=${code})`, this.deviceId);
                        this.connected = false;
                        this.connecting = false;
                        this.sessionActive = false;
                    });

                } catch (e) {
                    clearTimeout(connectTimeout);
                    this.connecting = false;
                    reject(e);
                }
            });
        } catch (e) {
            this.connecting = false;
            throw e;
        }
    }

    /**
     * 处理服务器事件
     * @param {Object} msg - 消息对象
     * @param {NodeJS.Timeout} connectTimeout - 连接超时定时器
     * @param {Function} resolve - Promise resolve函数
     * @param {Function} reject - Promise reject函数
     * @private
     */
    _handleEvent(msg, connectTimeout, resolve, reject) {
        switch (msg.event) {
            case TTS_EVENTS.CONNECTION_STARTED:
                clearTimeout(connectTimeout);
                this.connected = true;
                this.connecting = false;
                this.connectionId = msg.connectionId || msg.payload.connection_id || 'unknown';
                RuntimeUtil.makeLog('info',
                    `✅ [TTS] 连接已建立 (conn_id=${this.connectionId})`,
                    this.deviceId
                );
                resolve();
                break;

            case TTS_EVENTS.CONNECTION_FAILED:
                clearTimeout(connectTimeout);
                this.connecting = false;
                RuntimeUtil.makeLog('error',
                    `❌ [TTS] 连接失败: ${msg.payload.message}`,
                    this.deviceId
                );
                reject(new Error(msg.payload.message));
                break;

            case TTS_EVENTS.SESSION_STARTED:
                this.sessionActive = true;
                this.totalAudioBytes = 0;
                this.audioChunkCount = 0;
                this.lastChunkTime = null;
                this.sessionStartTime = null;
                RuntimeUtil.makeLog('info',
                    `⚡ [TTS] Session已启动 (${msg.sessionId})`,
                    this.deviceId
                );
                break;

            case TTS_EVENTS.SESSION_FINISHED:
                this.sessionActive = false;
                const sessionDuration = this.sessionStartTime
                    ? ((Date.now() - this.sessionStartTime) / 1000).toFixed(2)
                    : 'N/A';
                RuntimeUtil.makeLog('info',
                    `✅ [TTS] Session已结束: 总块数=${this.audioChunkCount}, 总字节=${this.totalAudioBytes}, Session耗时=${sessionDuration}s`,
                    this.deviceId
                );
                this.audioChunkCount = 0;
                this.lastChunkTime = null;
                this.sessionStartTime = null;
                setImmediate(() => {
                    this._audioSendPromise.then(() => {
                        if (this._sessionTimeout) { clearTimeout(this._sessionTimeout); this._sessionTimeout = null; }
                        if (this._sessionResolve) { this._sessionResolve(); this._sessionResolve = null; }
                    }).catch(() => {
                        if (this._sessionTimeout) { clearTimeout(this._sessionTimeout); this._sessionTimeout = null; }
                        if (this._sessionResolve) { this._sessionResolve(); this._sessionResolve = null; }
                    });
                });
                break;

            case TTS_EVENTS.TTS_SENTENCE_START:
                RuntimeUtil.makeLog('debug',
                    `[TTS] 句子开始: ${msg.payload.res_params?.text || ''}`,
                    this.deviceId
                );
                break;

            case TTS_EVENTS.TTS_SENTENCE_END:
                RuntimeUtil.makeLog('debug', `[TTS] 句子结束`, this.deviceId);
                break;
        }
    }

    /**
     * 合成文本
     * @param {string} text - 要合成的文本
     * @param {Object} [options] - 可选参数（覆盖配置，兼容官方文档扩展字段）
     * @returns {Promise<boolean>} - 合成结果
     */
    async synthesize(text, options = {}) {
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
                    uid: this.deviceId
                },
                req_params: {
                    speaker: voiceType,
                    audio_params: {
                        format: (encoding || 'pcm').toLowerCase(),
                        sample_rate: sampleRate,
                        speech_rate: speechRate,
                        loudness_rate: loudnessRate,
                        emotion,
                        ...audioParamsExtra
                    },
                    ...reqParamsExtra
                }
            };

            const startSessionFrame = this._buildEventFrame(
                TTS_EVENTS.START_SESSION,
                this.currentSessionId,
                sessionPayload
            );
            this.ws.send(startSessionFrame);

            const taskPayload = {
                req_params: {
                    text: text
                }
            };

            const taskFrame = this._buildEventFrame(
                TTS_EVENTS.TASK_REQUEST,
                this.currentSessionId,
                taskPayload
            );
            this.ws.send(taskFrame);

            RuntimeUtil.makeLog('info',
                `⚡ [TTS] 开始合成: "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}"`,
                this.deviceId
            );

            const finishFrame = this._buildEventFrame(
                TTS_EVENTS.FINISH_SESSION,
                this.currentSessionId,
                {}
            );
            this.ws.send(finishFrame);

            return new Promise((resolve) => {
                this._sessionResolve = resolve;
                this._sessionTimeout = setTimeout(() => {
                    if (this._sessionResolve) {
                        this._sessionResolve();
                        this._sessionResolve = null;
                    }
                    this._sessionTimeout = null;
                }, 30000);
            });
        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [TTS] 合成失败: ${e.message}`, this.deviceId);
            return Promise.resolve();
        }
    }

    /**
     * 等待当前会话已下发的音频全部送完（与 xiaozhi 串行下发配合，flush 前调用）
     * @returns {Promise<void>}
     */
    async waitAudioSent() {
        await this._audioSendPromise;
    }

    /**
     * 销毁客户端
     * @returns {Promise<void>}
     */
    async destroy() {
        // 清理统计信息
        this.totalAudioBytes = 0;
        this.audioChunkCount = 0;
        this.lastChunkTime = null;
        this.sessionStartTime = null;
        
        if (this.ws) {
            try {
                if (this.connected) {
                    const finishConnFrame = this._buildEventFrame(TTS_EVENTS.FINISH_CONNECTION, null, {});
                    this.ws.send(finishConnFrame);
                    await new Promise(resolve => setTimeout(resolve, 100));
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