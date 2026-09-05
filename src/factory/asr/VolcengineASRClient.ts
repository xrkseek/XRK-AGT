// @ts-nocheck
/**
 * 火山引擎ASR客户端
 * 实现语音识别功能，支持实时流式识别
 */

import WebSocket from 'ws';
import zlib from 'node:zlib';
import { v4 as uuidv4 } from 'uuid';
import RuntimeUtil from '#utils/runtime-util.js';
import { buildVolcengineSpeechHeaders } from '#utils/volcengine-speech-headers.js';

export default class VolcengineASRClient {
    _timeoutEmittedSet = new Set();
    _timeoutEmittedQueue = [];
    _timeoutEmittedMax = 64;
    ws = null;
    connected = false;
    connecting = false;
    sequence = 1;
    currentUtterance = null;
    _lastIntermediateText = '';
    lastMessageAt = 0;
    lastAudioAt = 0;
    logId = null;
    _idleTimer = null;
    _pingTimer = null;
    _pongTimer = null;
    reconnectAttempts = 0;
    _closingForRotate = false;
    performanceMetrics = {
        firstResultTime: null,
        audioStartTime: null,
    };

    /**
     * @param {string} deviceId
     * @param {Object} config
     * @param {Object} AgentRuntime
     */
    constructor(deviceId, config, AgentRuntime) {
        this.deviceId = deviceId;
        this.config = config;
        this.AgentRuntime = AgentRuntime;
        this.connectId = uuidv4();
    }

    /**
     * 生成WebSocket连接头部（新控制台 X-Api-Key；旧控制台 App-Key + Access-Key）
     * @returns {Object} 请求头对象
     * @private
     */
    _headers() {
        return buildVolcengineSpeechHeaders(this.config, { connectId: this.connectId });
    }

    _emitAsrTimeoutOnce(sessionId, reason = '') {
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
            reason
        });
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
     * 构建完整客户端请求（带音频配置）
     * @param {Object} audioInfo - 音频信息
     * @returns {Buffer} 请求Buffer
     * @private
     */
    _fullClientRequest(audioInfo) {
        const runtimeConfig = this.config || {};

        // 音频参数：以外部传入为主，配置仅作为默认值，字段名对齐火山官方 audio 配置
        const audioFormat = audioInfo?.format || runtimeConfig.format || 'pcm';
        const audioCodec = audioInfo?.codec || runtimeConfig.codec || 'raw';
        const rate = audioInfo?.rate || runtimeConfig.sampleRate || 16000;
        const bits = audioInfo?.bits || runtimeConfig.bits || 16;
        const channel = audioInfo?.channel || runtimeConfig.channel || runtimeConfig.channels || 1;
        const audioOptions = audioInfo?.audioOptions || {};

        // request 参数：允许按会话传入 modelName，其次才用配置
        const modelName = audioInfo?.modelName || runtimeConfig.modelName || 'bigmodel';
        const requestOptions = audioInfo?.requestOptions || {};

        const payload = {
            user: {
                uid: this.deviceId,
                platform: 'ESP32-S3'
            },
            audio: {
                format: audioFormat,
                codec: audioCodec,
                rate,
                bits,
                channel,
                ...audioOptions
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
                ...requestOptions
            }
        };

        const json = JSON.stringify(payload);
        const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
        const header = this._protoHeader(0x1, 0x0, 0x1, 0x1);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(gz.length, 0);

        return Buffer.concat([header, size, gz]);
    }

    /**
     * 构建纯音频请求
     * @param {Buffer} audioBuf - 音频数据
     * @param {boolean} isLast - 是否最后一帧
     * @returns {Buffer} 请求Buffer
     * @private
     */
    _audioOnlyRequest(audioBuf, isLast = false) {
        const gz = zlib.gzipSync(audioBuf);
        const flags = isLast ? 0x2 : 0x1;
        const header = this._protoHeader(0x2, flags, 0x0, 0x1);
        const payloadSize = Buffer.alloc(4);
        payloadSize.writeUInt32BE(gz.length, 0);

        if (!isLast) {
            this.sequence++;
            if (this.sequence > 0xFFFFFFFF) {
                this.sequence = 1;
            }
            const seq = Buffer.alloc(4);
            seq.writeUInt32BE(this.sequence, 0);
            return Buffer.concat([header, seq, payloadSize, gz]);
        }

        return Buffer.concat([header, payloadSize, gz]);
    }

    /**
     * 解析服务器返回的数据
     * @param {Buffer} data - 原始数据
     * @returns {Object|null} 解析结果
     * @private
     */
    _parse(data) {
        try {
            if (!data || data.length < 4) return null;

            const messageType = (data[1] >> 4) & 0x0F;
            const messageFlags = data[1] & 0x0F;
            const compression = data[2] & 0x0F;

            // 错误帧
            if (messageType === 0xF) {
                const errCode = data.readUInt32BE(4);
                const errSize = data.readUInt32BE(8);
                const msg = data.slice(12, 12 + errSize).toString('utf-8');
                return { type: 'error', errorCode: errCode, errorMessage: msg };
            }

            // 结果帧
            if (messageType === 0x9) {
                let offset = 4;
                if (messageFlags === 0x1 || messageFlags === 0x3) {
                    offset += 4;
                }
                const size = data.readUInt32BE(offset);
                offset += 4;
                let payload = data.slice(offset, offset + size);
                
                if (compression === 0x1) {
                    payload = zlib.gunzipSync(payload);
                }
                
                const result = JSON.parse(payload.toString('utf-8'));
                const isLast = messageFlags === 0x3 || messageFlags === 0x2;

                return { type: 'result', result, isLast };
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * 启动Ping定时器
     * @private
     */
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

    /**
     * 清除Ping定时器
     * @private
     */
    _clearPingTimer() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    /**
     * 启动Pong超时定时器
     * @private
     */
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

    /**
     * 清除Pong超时定时器
     * @private
     */
    _clearPongTimer() {
        if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
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
            throw new Error('连接超时');
        }

        this.connecting = true;

        try {
            await new Promise((resolve, reject) => {
                const connectTimeout = setTimeout(() => {
                    this.connecting = false;
                    reject(new Error('连接超时'));
                }, 8000);

                try {
                    // 每次新连接都刷新 connectId（对齐火山建议：用于链路追踪）
                    this.connectId = uuidv4();
                    const ws = new WebSocket(this.config.wsUrl, {
                        headers: this._headers(),
                        handshakeTimeout: 8000
                    });

                    this.ws = ws;

                    ws.on('open', () => {
                        clearTimeout(connectTimeout);
                        this.connected = true;
                        this.connecting = false;
                        this.lastMessageAt = Date.now();
                        this.reconnectAttempts = 0;

                        RuntimeUtil.makeLog('info', `⚡ [ASR] WebSocket已连接`, this.deviceId);
                        this._startPingTimer();
                        resolve();
                    });

                    ws.on('upgrade', (response) => {
                        this.logId = response.headers['x-tt-logid'];
                    });

                    ws.on('message', (buf) => {
                        this.lastMessageAt = Date.now();
                        const msg = this._parse(buf);

                        if (!msg) return;

                        RuntimeUtil.makeLog('debug', `[ASR] 收到消息 type=${msg.type} isLast=${msg.isLast ?? '-'}`, this.deviceId);

                        if (msg.type === 'error') {
                            this._handleError(msg);
                            return;
                        }

                        if (msg.type === 'result') {
                            if (!this.performanceMetrics.firstResultTime && this.performanceMetrics.audioStartTime) {
                                this.performanceMetrics.firstResultTime = Date.now() - this.performanceMetrics.audioStartTime;
                                RuntimeUtil.makeLog('info',
                                    `⚡ [ASR性能] 首字返回: ${this.performanceMetrics.firstResultTime}ms`,
                                    this.deviceId
                                );
                            }

                            this._handleResult(msg.result, msg.isLast);

                            if (msg.isLast) {
                                if (this.currentUtterance) {
                                    const totalTime = Date.now() - this.performanceMetrics.audioStartTime;
                                    RuntimeUtil.makeLog('info',
                                        `⚡ [ASR性能] 总处理时间: ${totalTime}ms`,
                                        this.deviceId
                                    );
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

                    ws.on('error', (err) => {
                        clearTimeout(connectTimeout);

                        if (err.message.includes('401')) {
                            RuntimeUtil.makeLog('error',
                                `❌ [ASR] 认证失败(401): 请检查 apiKey（新控制台）或 appKey/accessKey（旧控制台）与 resourceId`,
                                this.deviceId
                            );
                        } else {
                            RuntimeUtil.makeLog('error',
                                `❌ [ASR] WebSocket错误: ${err.message}`,
                                this.deviceId
                            );
                        }

                        this.connected = false;
                        this.connecting = false;
                        this.currentUtterance = null;
                        this._clearIdleTimer();
                        this._clearPingTimer();
                        this._clearPongTimer();
                        reject(err);
                    });

                    ws.on('close', (code) => {
                        if (this.ws !== ws) return;
                        RuntimeUtil.makeLog('info', `✓ [ASR] WebSocket关闭 (code=${code})`, this.deviceId);
                        this.connected = false;
                        this.connecting = false;

                        // 关闭时不再无条件触发 timeout：
                        // - ending=true：由 endUtterance 的 cleanupTimer 决定是否超时
                        // - 轮转关闭：不触发 timeout（新 utterance 会用新 WS）
                        // - 非 ending 且非轮转：认为是异常中断，触发 timeout
                        if (this.currentUtterance && !this._closingForRotate) {
                            const u = this.currentUtterance;
                            if (!u.ending) {
                                const sid = u.sessionId;
                                if (u._cleanupTimer) {
                                    clearTimeout(u._cleanupTimer);
                                    u._cleanupTimer = null;
                                }
                                this.currentUtterance = null;
                                this._emitAsrTimeoutOnce(sid, `ws_close:${code}`);
                            }
                        }

                        this._clearIdleTimer();
                        this._clearPingTimer();
                        this._clearPongTimer();

                        if (code !== 1000 && this.reconnectAttempts < (this.config.wsMaxReconnectAttempts || 5)) {
                            this._scheduleReconnect();
                        }
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
     * 安排重连
     * @private
     */
    _scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = Math.min(
            (this.config.wsReconnectDelayMs || 2000) * this.reconnectAttempts,
            10000
        );

        RuntimeUtil.makeLog('info',
            `🔄 [ASR] 将在${delay}ms后重连（第${this.reconnectAttempts}次）`,
            this.deviceId
        );

        setTimeout(() => {
            if (!this.connected && !this.connecting) {
                this._ensureConnected().catch(e => {
                    RuntimeUtil.makeLog('error', `❌ [ASR] 重连失败: ${e.message}`, this.deviceId);
                });
            }
        }, delay);
    }

    /**
     * 处理错误
     * @param {Object} msg - 错误消息
     * @private
     */
    _handleError(msg) {
        const errorCode = msg.errorCode;

        if (errorCode === 45000081) {
            const idleMs = this.lastMessageAt ? Date.now() - this.lastMessageAt : -1;
            const sessionId = this.currentUtterance?.sessionId ?? null;
            RuntimeUtil.makeLog('warn', `⚠️ [ASR] 服务器超时，清理状态`, this.deviceId);
            RuntimeUtil.makeLog('debug', `[ASR] 超时上下文: lastMessageAt距今=${idleMs}ms sessionId=${sessionId} errorMessage=${msg.errorMessage || ''}`, this.deviceId);
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
                    time: Math.floor(Date.now() / 1000)
                });
            }
            this._lastIntermediateText = '';
            this._emitAsrTimeoutOnce(sessionId, `server_error:${errorCode}`);
        } else if (errorCode === 45000000) {
            this.sequence = 1;
        } else {
            RuntimeUtil.makeLog('error',
                `❌ [ASR错误] ${errorCode}: ${msg.errorMessage}`,
                this.deviceId
            );
        }

        if (this.currentUtterance) {
            this.currentUtterance = null;
        }
        this._armIdleTimer();
    }

    /**
     * 处理识别结果
     * @param {Object} result - 识别结果
     * @param {boolean} isLast - 是否最后一个结果
     * @private
     */
    _handleResult(result, isLast) {
        try {
            const text = result?.result?.text || result?.text || '';
            const duration = result?.audio_info?.duration || 0;

            if (text) {
                const sessionId = this.currentUtterance?.sessionId;
                if (!isLast) this._lastIntermediateText = text;
                else this._lastIntermediateText = '';

                if (isLast) {
                    RuntimeUtil.makeLog('debug', `[ASR] 最终: "${text}"`, this.deviceId);
                } else {
                    RuntimeUtil.makeLog('debug', `[ASR] 中间: "${text}"`, this.deviceId);
                }

                // 发送事件
                if (this.AgentRuntime[this.deviceId]) {
                    this.AgentRuntime.em('device.asr_result', {
                        post_type: 'device',
                        event_type: 'asr_result',
                        device_id: this.deviceId,
                        session_id: sessionId || null,
                        text,
                        is_final: !!isLast,
                        duration,
                        result: result?.result || result,
                        self_id: this.deviceId,
                        time: Math.floor(Date.now() / 1000)
                    });
                }
            }
        } catch (e) {
            RuntimeUtil.makeLog('error',
                `❌ [ASR] 处理结果失败: ${e.message}`,
                this.deviceId
            );
        }
    }

    /**
     * 启动空闲定时器
     * @private
     */
    _armIdleTimer() {
        if (this.config.idleCloseMs > 0) {
            this._clearIdleTimer();
            this._idleTimer = setTimeout(() => {
                if (this.ws && this.connected && !this.currentUtterance) {
                    RuntimeUtil.makeLog('info', `✓ [ASR] 空闲超时，关闭连接`, this.deviceId);
                    this.ws.close();
                }
            }, this.config.idleCloseMs);
        }
    }

    /**
     * 清除空闲定时器
     * @private
     */
    _clearIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    /**
     * 开始一个utterance（公共API）
     * @param {string} sessionId - 会话ID
     * @param {Object} audioInfo - 音频信息
     * @returns {Promise<void>}
     */
    async beginUtterance(sessionId, audioInfo) {
        // 对齐稳定策略：每个 utterance 使用独立 WebSocket，避免 end/close/timeout 串台
        // 先尽力结束上一轮（如果有）
        if (this.currentUtterance && !this.currentUtterance.ending) {
            try { await this.endUtterance(); } catch { /* ignore */ }
        }
        // 轮转关闭旧连接（无论是否 connected），确保新 utterance 干净开始
        if (this.ws) {
            this._closingForRotate = true;
            try {
                await new Promise((resolve) => {
                    const w = this.ws;
                    let done = false;
                    const finish = () => {
                        if (done) return;
                        done = true;
                        resolve();
                    };
                    const t = setTimeout(finish, 1000);
                    try {
                        w.once('close', () => {
                            clearTimeout(t);
                            finish();
                        });
                        if (w.readyState === 1) w.close(1000, 'rotate utterance');
                        else w.terminate();
                    } catch {
                        clearTimeout(t);
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
            audioStartTime: Date.now()
        };

        this.currentUtterance = {
            sessionId,
            startedAt: Date.now(),
            ending: false
        };
        this._lastIntermediateText = '';
        this.sequence = 1;

        const fullReq = this._fullClientRequest({
            rate: audioInfo?.sample_rate || 16000,
            bits: audioInfo?.bits || 16,
            channel: audioInfo?.channels || 1,
            format: audioInfo?.format,
            codec: audioInfo?.codec,
            modelName: audioInfo?.modelName
        });

        this.ws.send(fullReq);
        RuntimeUtil.makeLog('info', `⚡ [ASR会话] 开始: ${sessionId}`, this.deviceId);
    }

    /**
     * 发送音频数据（公共API）
     * @param {Buffer} audioBuf - 音频数据
     * @returns {boolean} 是否成功
     */
    sendAudio(audioBuf) {
        if (!this.ws || !this.connected) return false;
        if (!this.currentUtterance || this.currentUtterance.ending) return false;
        if (!audioBuf || audioBuf.length === 0) return true; // 空数据不发送，但返回成功

        try {
            const frame = this._audioOnlyRequest(audioBuf, false);
            this.ws.send(frame);
            this.lastAudioAt = Date.now();
            return true;
        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [ASR] 发送音频失败: ${e.message}`, this.deviceId);
            return false;
        }
    }

    /**
     * 结束utterance（公共API）
     * @returns {Promise<boolean>} 是否成功
     */
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

            // endUtterance 发送 end 后，服务端应回一条 isLast=true；
            // 若超时未收到则强制清理并通知上层（默认 8 秒，避免长句/网络抖动导致误判）
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
            
            // 保存清理定时器，在收到最终结果时清除
            if (this.currentUtterance) {
                this.currentUtterance._cleanupTimer = cleanupTimer;
            }

            this._armIdleTimer();
            return true;

        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [ASR] 结束失败: ${e.message}`, this.deviceId);
            this.currentUtterance = null;
            this._armIdleTimer();
            return false;
        }
    }

    /**
     * 销毁客户端
     * @returns {Promise<void>}
     */
    async destroy() {
        // 清理所有定时器
        this._clearIdleTimer();
        this._clearPingTimer();
        this._clearPongTimer();
        
        // 清理会话清理定时器
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
            audioStartTime: null
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