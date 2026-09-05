// @ts-nocheck
/**
 * Device HTTP/WebSocket 服务
 * 
 * 职责：
 * 1. 提供 WebSocket 连接管理（web 客户端连接）
 * 2. 接收 tasker 发送的消息，转发到 web 客户端
 * 3. 将文件路径转换为 web 可访问的 URL
 * 4. 支持多种协议：WebSocket（实时通信）、HTTP（文件服务）
 * 
 * Tasker 职责：
 * - 处理平台协议（OneBot、Telegram 等）
 * - 发送标准格式的 segments 到 device.js
 * - 不关心 web 客户端的实现细节
 * 
 * Web 客户端职责：
 * - 通过 WebSocket 接收标准化的 segments
 * - 渲染文本和图片（按顺序）
 * - 支持多种协议：WebSocket（实时）、HTTP（文件访问）
 */

import WebSocket from 'ws';
import RuntimeUtil from '#utils/runtime-util.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import fs from 'fs';
import path from 'path';
import paths from '#utils/paths.js';
import ASRFactory from '#factory/asr/ASRFactory.js';
import TTSFactory from '#factory/tts/TTSFactory.js';
import { HttpResponse } from '#utils/http-utils.js';
import { InputValidator } from '#utils/input-validator.js';
import {
    getAiWorkflowConfig,
    getLLMSettings,
    getTtsConfig,
    getAsrConfig,
    getSystemConfig
} from '#utils/ai-workflow-config.js';
import {
    SUPPORTED_EMOTIONS,
    normalizeEmotionToDevice,
    findEmotionFromKeywords
} from '#utils/emotion-utils.js';
import {
    initializeDirectories,
    validateDeviceRegistration,
    generateCommandId,
    hasCapability,
    getAudioFileList
} from '#utils/deviceutil.js';
import { Disposables } from '#utils/disposables.js';

const DEVICE_FILE_ROOTS = [paths.data, paths.trash, paths.resources];

// ==================== 全局存储 ====================
const devices = new Map();
const deviceWebSockets = new Map();
const deviceLogs = new Map();
/** 按 deviceId 存储最近 N 条对话（用户+助手），供 getChatHistory 拉取并参与 LLM 上下文，单设备最多 50 条 */
const deviceChatHistory = new Map();
const DEVICE_CHAT_HISTORY_MAX = 50;

function pushDeviceChatMessage(deviceId, { user_id, nickname, message, message_id, time }) {
    if (!deviceId || message == null) return;
    let list = deviceChatHistory.get(deviceId);
    if (!list) {
        list = [];
        deviceChatHistory.set(deviceId, list);
    }
    const n = nickname || '用户';
    const mid = message_id || `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    list.push({
        user_id: user_id ?? deviceId,
        nickname: n,
        sender: { card: n, nickname: n },
        message: String(message),
        message_id: mid,
        real_id: mid,
        time: time ?? Math.floor(Date.now() / 1000),
        raw_message: String(message)
    });
    if (list.length > DEVICE_CHAT_HISTORY_MAX) {
        list.splice(0, list.length - DEVICE_CHAT_HISTORY_MAX);
    }
}

function getDeviceChatHistory(deviceId, count = 20) {
    const list = deviceChatHistory.get(deviceId);
    if (!Array.isArray(list) || list.length === 0) return [];
    const take = Math.min(Math.max(1, count), list.length);
    return list.slice(-take);
}
const deviceCommands = new Map();
const commandCallbacks = new Map();
const deviceStats = new Map();
// 前端TTS队列状态（用于后端实时背压）
// key: deviceId, value: { queueLen, playing, activeSources, ts }
const ttsQueueStatus = new Map();

const CONNECTION_LOG_WINDOW_MS = 2000;
const connectionLogTracker = new Map();

function shouldLogConnection(remote) {
    const now = Date.now();
    const last = connectionLogTracker.get(remote) || 0;
    if (now - last < CONNECTION_LOG_WINDOW_MS) {
        return false;
    }
    connectionLogTracker.set(remote, now);
    return true;
}

/** 判断字符串是否为十六进制形式 */
function isHexString(str) {
    if (typeof str !== 'string') return false;
    const s = str.trim();
    return !!s && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * 解码 ASR 音频负载。支持：hex/base64 字符串、ArrayBuffer/TypedArray/Buffer、number[]（PCM 采样）。
 * 支持 payload.data / payload.audio.data 及 audio 包装；编码假定为 PCM。
 * @param {Object} payload - WebSocket 上报数据
 * @param {string} deviceId - 设备ID（日志用）
 * @returns {Buffer} PCM Buffer，失败或空则返回空 Buffer
 */
function decodeAsrAudioPayload(payload, deviceId) {
    try {
        if (!payload || typeof payload !== 'object') return Buffer.alloc(0);

        const audio = payload.audio || {};
        const encoding = (audio.encoding || payload.encoding || '').toString().toLowerCase();

        let raw = audio.data;
        if (raw == null) raw = payload.data;
        if (raw == null) raw = payload.audioData;

        if (raw == null) return Buffer.alloc(0);

        // 已经是 Buffer
        if (Buffer.isBuffer(raw)) return raw;

        // ArrayBuffer / TypedArray
        if (raw instanceof ArrayBuffer) {
            return Buffer.from(new Uint8Array(raw));
        }
        if (ArrayBuffer.isView && ArrayBuffer.isView(raw)) {
            return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        }

        // 数组：视为 PCM 采样值
        if (Array.isArray(raw)) {
            const samples = raw.map(v => Number.isFinite(v) ? v : 0);
            if (!samples.length) return Buffer.alloc(0);

            // 简单判断是否为 float 采样
            const hasFloat = samples.some(v => Math.abs(v) <= 1 && !Number.isInteger(v));
            const buf = Buffer.allocUnsafe(samples.length * 2);
            for (let i = 0; i < samples.length; i++) {
                let s = samples[i];
                if (hasFloat) {
                    // float [-1,1] -> int16
                    s = Math.max(-1, Math.min(1, s));
                    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                s = Math.max(-32768, Math.min(32767, s | 0));
                buf.writeInt16LE(s, i * 2);
            }
            return buf;
        }

        // 字符串：hex / base64
        if (typeof raw === 'string') {
            const s = raw.trim();
            if (!s) return Buffer.alloc(0);

            // 显式声明 hex / pcm_hex，或符合 hex 形态时按 hex 解析
            if (!encoding || encoding === 'hex' || encoding === 'pcm_hex') {
                if (isHexString(s)) {
                    return Buffer.from(s, 'hex');
                }
            }

            // 其他情况按 base64 处理（支持前缀 base64:）
            const b64 = s.startsWith('base64:') ? s.slice(7) : s;
            try {
                return Buffer.from(Uint8Array.fromBase64(b64));
            } catch (e) {
                RuntimeUtil.makeLog(
                    'error',
                    `❌ [ASR] base64 音频解码失败: ${e.message}`,
                    deviceId
                );
                return Buffer.alloc(0);
            }
        }

        RuntimeUtil.makeLog(
            'warn',
            '[ASR] 收到无法识别的音频数据类型，已忽略该分片',
            deviceId
        );
        return Buffer.alloc(0);
    } catch (e) {
        RuntimeUtil.makeLog(
            'error',
            `❌ [ASR] 解码音频数据异常: ${e.message}`,
            deviceId
        );
        return Buffer.alloc(0);
    }
}

const asrClients = new Map();
const ttsClients = new Map();
const asrSessions = new Map();

const LOG_THROTTLE_CACHE = new Map();
const DEFAULT_LOG_THROTTLE = 1200;
let __runtime = null;

function shouldEmitThrottledLog(key, windowMs = DEFAULT_LOG_THROTTLE) {
    const now = Date.now();
    const previous = LOG_THROTTLE_CACHE.get(key);
    if (previous && now - previous < windowMs) {
        return false;
    }
    LOG_THROTTLE_CACHE.set(key, now);
    if (LOG_THROTTLE_CACHE.size > 5000) {
        const cutoff = now - windowMs * 5;
        for (const [entryKey, timestamp] of LOG_THROTTLE_CACHE) {
            if (timestamp < cutoff) {
                LOG_THROTTLE_CACHE.delete(entryKey);
            }
        }
    }
    return true;
}

function logWithThrottle(level, message, scope, key, windowMs = DEFAULT_LOG_THROTTLE) {
    if (shouldEmitThrottledLog(key, windowMs)) {
        RuntimeUtil.makeLog(level, message, scope);
    }
}

// ==================== 设备管理器类 ====================
class DeviceManager {
    constructor() {
        this.cleanupInterval = null;
        const systemConfig = getSystemConfig();
        this.AUDIO_SAVE_DIR = systemConfig.audio?.saveDir || './data/wav';
        this.bot = null;
        this._deviceEventListener = null;
        this.initializeDirectories();
    }

    setBot(botInstance) {
        this.bot = botInstance;
    }

    getBot(override) {
        const runtime = override || this.bot;
        if (!runtime) {
            throw new Error('DeviceManager: AgentRuntime 实例未初始化');
        }
        return runtime;
    }

    /**
     * 初始化目录
     */
    initializeDirectories() {
        initializeDirectories([this.AUDIO_SAVE_DIR]);
    }

    attachDeviceEventBridge(botInstance = this.bot) {
        if (botInstance) {
            this.bot = botInstance;
        }
        if (!this.bot?.on) return;
        this.detachDeviceEventBridge();
        this._deviceEventListener = (e) => {
        try {
                if (!e || e.event_type !== 'asr_result') return;
                const deviceId = e.device_id;
                const sessionId = e.session_id;
                const text = e.text || '';
                const isFinal = !!e.is_final;
                const duration = e.duration || 0;
                const session = asrSessions.get(sessionId);
                if (session && session.deviceId === deviceId) {
                    if (isFinal) {
                        // 累积最终文本，避免“前面识别出来、后面被覆盖掉”
                        const prev = session.finalText || '';
                        if (!prev) {
                            session.finalText = text;
                        } else if (text && text.startsWith(prev)) {
                            // 引擎返回“到目前为止的整句”——直接使用更长的
                            session.finalText = text;
                        } else if (text && prev.startsWith(text)) {
                            // 引擎返回的 text 比已有的短：保持更长的，不回退
                            session.finalText = prev;
                        } else if (text) {
                            // 无法判断增量策略时，采用追加，宁可重复也不丢字
                            session.finalText = prev + text;
                        }
                        session.finalDuration = duration;
                        session.finalTextSetAt = Date.now();
                        const ws = deviceWebSockets.get(deviceId);
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'asr_final',
                                device_id: deviceId,
                                session_id: sessionId,
                                text
                            }));
                        }
                    } else if (text) {
                        const ws = deviceWebSockets.get(deviceId);
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'asr_interim',
                                device_id: deviceId,
                                session_id: sessionId,
                                text
                            }));
                        }
                    }
                }
            } catch { }
        };
        this.bot.on('device', this._deviceEventListener);
    }

    detachDeviceEventBridge() {
        if (!this._deviceEventListener || !this.bot) {
            this._deviceEventListener = null;
            return;
        }
        if (typeof this.bot.off === 'function') {
            this.bot.off('device', this._deviceEventListener);
        } else if (typeof this.bot.removeListener === 'function') {
            this.bot.removeListener('device', this._deviceEventListener);
        }
        this._deviceEventListener = null;
    }

    /**
     * 获取ASR客户端（懒加载）
     * @param {string} deviceId - 设备ID
     * @returns {Object} ASR客户端
     * @private
     */
    _getASRClient(deviceId, config) {
        let client = asrClients.get(deviceId);
        if (!client || client.__provider !== config.provider) {
            client = ASRFactory.createClient(deviceId, config, this.getBot());
            client.__provider = config.provider;
            asrClients.set(deviceId, client);
        }
        return client;
    }

    /**
     * 获取TTS客户端（懒加载）
     * @param {string} deviceId - 设备ID
     * @returns {Object} TTS客户端
     * @private
     */
    _getTTSClient(deviceId, config) {
        let client = ttsClients.get(deviceId);
        if (!client || client.__provider !== config.provider) {
            client = TTSFactory.createClient(deviceId, config, this.getBot());
            client.__provider = config.provider;
            ttsClients.set(deviceId, client);
        }
        return client;
    }

    // ==================== ASR会话处理（优化版）====================

    /**
     * 处理ASR会话开始
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 会话数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRSessionStart(deviceId, data) {
        try {
            const {
                session_id,
                sample_rate,
                bits,
                channels,
                session_number,
                audio_format,
                audio_codec,
                format,
                codec,
                model,
                model_name,
                asr_model
            } = data;
            const asrConfig = getAsrConfig();

            RuntimeUtil.makeLog('info',
                `⚡ [ASR会话#${session_number}] 开始: ${session_id}`,
                deviceId
            );

            if (!asrConfig.enabled) {
                return { success: false, error: 'ASR未启用' };
            }

            const client = this._getASRClient(deviceId, asrConfig);
            
            if (client.currentUtterance && !client.currentUtterance.ending) {
                RuntimeUtil.makeLog('warn',
                    `⚠️ [ASR] 已有活跃会话，先结束: ${client.currentUtterance.sessionId}`,
                    deviceId
                );
                try {
                    await client.endUtterance();
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (e) {
                    RuntimeUtil.makeLog('warn',
                        `⚠️ [ASR] 结束旧会话失败: ${e.message}`,
                        deviceId
                    );
                }
            }
            
            asrSessions.set(session_id, {
                deviceId,
                sample_rate,
                bits,
                channels,
                sessionNumber: session_number,
                startTime: Date.now(),
                lastChunkTime: Date.now(),
                totalChunks: 0,
                totalBytes: 0,
                asrStarted: false,
                endingChunks: 0,
                earlyEndSent: false,
                finalText: null,
                finalDuration: 0,
                finalTextSetAt: null,
                maxWaitMs: typeof asrConfig.asrFinalTextWaitMs === 'number'
                    ? Math.max(0, asrConfig.asrFinalTextWaitMs)
                    : 3000
            });

            try {
                await client.beginUtterance(session_id, {
                    sample_rate,
                    bits,
                    channels,
                    format: audio_format || format,
                    codec: audio_codec || codec,
                    modelName: model_name || model || asr_model
                });
                asrSessions.get(session_id).asrStarted = true;
            } catch (e) {
                RuntimeUtil.makeLog('error',
                    `❌ [ASR] 启动utterance失败: ${e.message}`,
                    deviceId
                );
                asrSessions.delete(session_id);
                return { success: false, error: e.message };
            }

            return { success: true, session_id };

        } catch (e) {
            RuntimeUtil.makeLog('error',
                `❌ [ASR会话] 启动失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 处理ASR音频块
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 音频数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRAudioChunk(deviceId, data) {
        try {
            const { session_id, chunk_index, vad_state } = data;
            const asrConfig = getAsrConfig();

            if (!asrConfig.enabled) {
                return { success: false, error: 'ASR未启用' };
            }

            const session = asrSessions.get(session_id);
            if (!session) {
                return { success: false, error: '会话不存在' };
            }

            const audioBuf = decodeAsrAudioPayload(data, deviceId);

            session.totalChunks++;
            session.totalBytes += audioBuf.length;
            const now = Date.now();
            const interval = session.lastChunkTime ? (now - session.lastChunkTime) : 0;
            session.lastChunkTime = now;

            const sr = session.sample_rate || 16000;
            const duration = audioBuf.length > 0 ? (audioBuf.length / 2) / sr : 0;

            // ASR后端调试日志：逐块统计，方便对比前端是否丢包
            RuntimeUtil.makeLog(
                'debug',
                `[ASR后端] 收到音频块 #${chunk_index}: 字节=${audioBuf.length}, 时长=${duration.toFixed(3)}s, 间隔=${interval}ms, ` +
                `累计块数=${session.totalChunks}, 累计字节=${session.totalBytes}`,
                deviceId
            );

            if (session.asrStarted && (vad_state === 'active' || vad_state === 'ending')) {
                const client = this._getASRClient(deviceId, asrConfig);
                if (client.connected && client.currentUtterance && !client.currentUtterance.ending) {
                    client.sendAudio(audioBuf);

                    if (vad_state === 'ending') {
                        session.endingChunks = (session.endingChunks || 0) + 1;

                        if (session.endingChunks >= 2 && !session.earlyEndSent) {
                            session.earlyEndSent = true;

                            RuntimeUtil.makeLog('info',
                                `⚡ [ASR] 检测到ending×${session.endingChunks}，提前结束`,
                                deviceId
                            );

                            client.endUtterance().catch((e) => {
        RuntimeUtil.makeLog('error',
                                    `❌ [ASR] 提前结束失败: ${e.message}`,
                                    deviceId
                                );
                            });
                        }
                    } else {
                        session.endingChunks = 0;
                        session.earlyEndSent = false;
                    }
                }
            }

            return { success: true, received: chunk_index };

        } catch (e) {
            RuntimeUtil.makeLog('error',
                `❌ [ASR] 处理音频块失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 处理ASR会话停止（优化版 - 不等待最终文本）
     * @param {string} deviceId - 设备ID
     * @param {Object} data - 会话数据
     * @returns {Promise<Object>} 处理结果
     */
    async handleASRSessionStop(deviceId, data) {
        try {
            const { session_id, duration, session_number } = data;
            const asrConfig = getAsrConfig();

            RuntimeUtil.makeLog('info',
                `✓ [ASR会话#${session_number}] 停止: ${session_id} (时长=${duration}s)`,
                deviceId
            );

            const session = asrSessions.get(session_id);
            if (!session) {
                return { success: true };
            }

            // 避免重复处理同一会话停止
            if (session.stopped) {
                return { success: true };
            }
            session.stopped = true;

            if (session.asrStarted && asrConfig.enabled) {
                const client = this._getASRClient(deviceId, asrConfig);

                if (!session.earlyEndSent) {
                    try {
                        await client.endUtterance();
                        RuntimeUtil.makeLog('info',
                            `✓ [ASR会话#${session_number}] Utterance已结束`,
                            deviceId
                        );
                    } catch (e) {
                        RuntimeUtil.makeLog('warn',
                            `⚠️ [ASR] 结束utterance失败: ${e.message}`,
                            deviceId
                        );
                    }
                }
            }

            // ⭐ 关键改进：异步等待最终文本，不阻塞流程
            this._waitForFinalTextAsync(deviceId, session);

            // ASR会话统计日志：用于与前端对比是否有丢包/时长偏差
            try {
                const elapsedMs = session.lastChunkTime && session.startTime
                    ? (session.lastChunkTime - session.startTime)
                    : 0;
                const totalDuration = session.totalBytes > 0 && session.sample_rate
                    ? (session.totalBytes / 2) / session.sample_rate
                    : 0;
                const avgChunkSize = session.totalChunks > 0
                    ? Math.round(session.totalBytes / session.totalChunks)
                    : 0;

                RuntimeUtil.makeLog(
                    'info',
                    `[ASR后端] 会话统计#${session_number}: 总块数=${session.totalChunks}, 总字节=${session.totalBytes}, ` +
                    `平均块大小=${avgChunkSize}字节, 音频估算时长=${totalDuration.toFixed(3)}s, 接收耗时=${(elapsedMs / 1000).toFixed(3)}s`,
                    deviceId
                );
            } catch {
                // 忽略统计日志错误
            }

            return { success: true };

        } catch (e) {
            RuntimeUtil.makeLog('error',
                `❌ [ASR会话] 停止失败: ${e.message}`,
                deviceId
            );
            return { success: false, error: e.message };
        }
    }

    /**
     * 异步等待最终文本并处理AI（新增）
     * @param {string} deviceId - 设备ID
     * @param {Object} session - 会话对象
     * @private
     */
    async _waitForFinalTextAsync(deviceId, session) {
        const maxWaitMs = typeof session.maxWaitMs === 'number' && session.maxWaitMs > 0
            ? session.maxWaitMs
            : 3000;  // 默认最多等待3秒（可通过配置调整）
        const checkIntervalMs = 50;
        let waitCount = 0;
        const maxChecks = Math.ceil(maxWaitMs / checkIntervalMs);

        while (!session.finalText && waitCount < maxChecks) {
            await new Promise(r => setTimeout(r, checkIntervalMs));
            waitCount++;
        }

        if (session.finalText) {
            const waitedMs = waitCount * checkIntervalMs;
            RuntimeUtil.makeLog('info',
                `✅ [ASR最终] "${session.finalText}" (等待${waitedMs}ms)`,
                deviceId
            );

            // 将最终识别结果推送给前端设备
            try {
                const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'asr_final',
                        device_id: deviceId,
                        session_id: session.session_id,
                        text: session.finalText
                    }));
                }
            } catch {
                // 忽略发送失败，交由重试/心跳机制处理
            }
        } else {
            RuntimeUtil.makeLog('warn',
                `⚠️ [ASR] 等待最终结果超时(${maxWaitMs}ms)`,
                deviceId
            );
            RuntimeUtil.makeLog('debug', `[ASR] 等待最终结果超时上下文: session_id=${session.session_id}`, deviceId);

            // 超时也要通知设备端，避免卡住
            await this._sendAIError(deviceId);
        }

        // 清理会话
        asrSessions.delete(session.session_id);
    }

    // ==================== AI处理 ====================

    /**
     * 处理AI响应
     * @param {string} deviceId - 设备ID
     * @param {string} question - 用户问题
     * @returns {Promise<void>}
     * @private
     */
    async _processAIResponse(deviceId, question, options = {}) {
        try {
            const startTime = Date.now();
            const fromASR = options.fromASR === true;

            RuntimeUtil.makeLog('info',
                `⚡ [AI] 开始处理: ${question.substring(0, 50)}${question.length > 50 ? '...' : ''}`,
                deviceId
            );

            const runtimeBot = this.getBot();
            const deviceInfo = devices.get(deviceId);
            const deviceBot = runtimeBot[deviceId];

            if (!deviceBot) {
                RuntimeUtil.makeLog('error', '❌ [AI] 设备AgentRuntime未找到', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            // ASR识别结果直接返回文本，不调用工作流
            const workflowName = options.workflow || 'device';

            const streamName = workflowName || 'device';
            // 仓库无默认 device 流：回退 chat（设备场景可配 mergeWorkflows）
            const deviceStream =
              AiWorkflowLoader.getWorkflow(streamName) ||
              AiWorkflowLoader.getWorkflow('device') ||
              AiWorkflowLoader.getWorkflow('chat');
            if (!deviceStream) {
                RuntimeUtil.makeLog('error', `[AI] 工作流未加载: ${streamName}（且无 chat 回退）`, deviceId);
                await this._sendAIError(deviceId);
                return;
            }
            if (deviceStream.name !== streamName) {
                RuntimeUtil.makeLog(
                  'debug',
                  `[AI] 工作流 ${streamName} 不存在，回退 ${deviceStream.name}`,
                  deviceId
                );
            }

            const streamConfig = getLLMSettings({
                workflow: streamName,
                persona: options.persona,
                profile: options.profile
            });
            if (!streamConfig.enabled) {
                // warn: 工作流已禁用需要关注
                RuntimeUtil.makeLog('warn', '⚠️ [AI] 工作流已禁用', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            // 若工具调用/慢响应导致长时间无声：延迟播一句提示音（可配置化前先给默认行为）
            const ttsConfig = getTtsConfig();
            const aiWorkflowTtsConfig = getAiWorkflowConfig().tts || {};
            const ttsOnlyForASR = aiWorkflowTtsConfig.onlyForASR !== false; // 默认只有ASR触发才有TTS
            const shouldPlayTTS = Boolean(ttsConfig.enabled && (fromASR || !ttsOnlyForASR));

            // 默认：1.2s 后仍未出结果则先播一句，避免用户误以为卡住
            const progressText = String(aiWorkflowTtsConfig.progressSpeechText || '我查一下，请稍等。');
            const progressDelayMs = Number.isFinite(Number(aiWorkflowTtsConfig.progressSpeechDelayMs))
                ? Math.max(0, Number(aiWorkflowTtsConfig.progressSpeechDelayMs))
                : 1200;
            const progressEnabled = aiWorkflowTtsConfig.progressSpeechEnabled !== false;

            // 调用工作流（工作流内部会自动选择LLM工厂）
            let aiResult;
            let waiting = true;
            let progressTimer = null;
            let progressPromise = null;

            if (progressEnabled && shouldPlayTTS && progressText.trim()) {
                progressTimer = setTimeout(() => {
        if (!waiting) return;
                    try {
                        const ttsClient = this._getTTSClient(deviceId, ttsConfig);
                        RuntimeUtil.makeLog('info', `🔊 [TTS] AI较慢/工具调用中，先播提示语音`, deviceId);
                        progressPromise = Promise.resolve()
                            .then(() => ttsClient.synthesize(progressText))
                            .then(() => (typeof ttsClient.waitAudioSent === 'function' ? ttsClient.waitAudioSent() : null))
                            .catch(() => null);
                    } catch {
                        // ignore
                    }
                }, progressDelayMs);
            }

            try {
                aiResult = await deviceStream.execute(
                    deviceId,
                    question,
                    streamConfig,
                    deviceInfo || {},
                    streamConfig.persona
                );
            } finally {
                waiting = false;
                if (progressTimer) {
                    try { clearTimeout(progressTimer); } catch { }
                    progressTimer = null;
                }
                // 若已触发提示 TTS，等待它结束，避免与正式回复 TTS 并发导致截断/抢占
                if (progressPromise) {
                    try { await progressPromise; } catch { }
                }
            }

            if (!aiResult) {
                // warn: 未返回结果需要关注
                RuntimeUtil.makeLog('warn', '⚠️ [AI] 工作流执行完成，但未返回结果', deviceId);
                await this._sendAIError(deviceId);
                return;
            }

            const aiTime = Date.now() - startTime;
            // info: AI性能和回复是重要的业务信息
            RuntimeUtil.makeLog('info', `⚡ [AI性能] [${deviceStream.name}] 耗时: ${aiTime}ms`, deviceId);
            RuntimeUtil.makeLog('info', `✅ [AI] 回复: ${aiResult.text || '(仅表情)'}`, deviceId);

            // 显示表情
            const emotionCode = normalizeEmotionToDevice(aiResult.emotion);
            if (emotionCode) {
                try {
                    await deviceBot.emotion(emotionCode);
                    RuntimeUtil.makeLog('info', `✓ [设备] 表情: ${emotionCode}`, deviceId);
                } catch (e) {
                    RuntimeUtil.makeLog('error', `❌ [设备] 表情显示失败: ${e.message}`, deviceId);
                }
            }

            // 播放TTS（只有ASR触发或配置允许时才播放）
            if (aiResult.text && ttsConfig.enabled) {
                if (shouldPlayTTS) {
                    try {
                        const ttsClient = this._getTTSClient(deviceId, ttsConfig);
                        const success = await ttsClient.synthesize(aiResult.text);

                        if (success) {
                            RuntimeUtil.makeLog('info', `🔊 [TTS] 语音合成已启动`, deviceId);
                        } else {
                            RuntimeUtil.makeLog('error', `❌ [TTS] 语音合成失败`, deviceId);
                            await this._sendAIError(deviceId);
                        }
                    } catch (e) {
                        RuntimeUtil.makeLog('error', `❌ [TTS] 语音合成异常: ${e.message}`, deviceId);
                        await this._sendAIError(deviceId);
                    }
                }
            }

            // 显示文字
            if (aiResult.text) {
                try {
                    await deviceBot.display(aiResult.text, {
                        x: 0,
                        y: 0,
                        font_size: 16,
                        wrap: true,
                        spacing: 2
                    });
                    RuntimeUtil.makeLog('info', `✓ [设备] 文字: ${aiResult.text}`, deviceId);
                } catch (e) {
                    RuntimeUtil.makeLog('error', `❌ [设备] 文字显示失败: ${e.message}`, deviceId);
                }
            }

        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [AI] 处理失败: ${e.message}`, deviceId);
            await this._sendAIError(deviceId);
        }
    }

    /**
     * 发送AI错误通知
     * @param {string} deviceId - 设备ID
     * @private
     */
    async _sendAIError(deviceId) {
        try {
            const runtimeBot = this.getBot();
            const deviceBot = runtimeBot[deviceId];
            if (deviceBot && deviceBot.sendCommand) {
                await deviceBot.sendCommand('ai_error', {}, 1);
            }
        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [AI] 发送错误通知失败: ${e.message}`, deviceId);
        }
    }

    // ==================== 设备管理 ====================

    /**
     * 初始化设备统计
     * @param {string} deviceId - 设备ID
     * @returns {Object} 统计对象
     */
    initDeviceStats(deviceId) {
        const stats = {
            device_id: deviceId,
            connected_at: Date.now(),
            total_messages: 0,
            total_commands: 0,
            total_errors: 0,
            last_heartbeat: Date.now()
        };
        deviceStats.set(deviceId, stats);
        return stats;
    }

    /**
     * 更新设备统计
     * @param {string} deviceId - 设备ID
     * @param {string} type - 统计类型
     */
    updateDeviceStats(deviceId, type) {
        const stats = deviceStats.get(deviceId);
        if (!stats) return;

        if (type === 'message') stats.total_messages++;
        if (type === 'command') stats.total_commands++;
        if (type === 'error') stats.total_errors++;
        if (type === 'heartbeat') stats.last_heartbeat = Date.now();
    }

    /**
     * 添加设备日志
     * @param {string} deviceId - 设备ID
     * @param {string} level - 日志级别
     * @param {string} message - 日志消息
     * @param {Object} data - 附加数据
     * @returns {Object} 日志条目
     */
    addDeviceLog(deviceId, level, message, data = {}) {
        message = String(message).substring(0, 500);
        const systemConfig = getSystemConfig();

        const entry = {
            timestamp: Date.now(),
            level,
            message,
            data
        };

        const logs = deviceLogs.get(deviceId) || [];
        logs.unshift(entry);

        const maxLogs = systemConfig.limits?.maxLogsPerDevice || 100;
        if (logs.length > maxLogs) {
            logs.length = maxLogs;
        }

        deviceLogs.set(deviceId, logs);

        const device = devices.get(deviceId);
        if (device?.stats && level === 'error') {
            device.stats.errors++;
            this.updateDeviceStats(deviceId, 'error');
        }

        if (level !== 'debug' || systemConfig.logging?.enableDetailedLogs) {
            const scope = device?.device_name || deviceId;
            const dedupWindow = Number(systemConfig.logDedupWindowMs) || DEFAULT_LOG_THROTTLE;
            logWithThrottle(
                level,
                `[${scope}] ${message}`,
                scope,
                `device-log:${deviceId}:${level}:${message}`,
                dedupWindow
            );
        }

        return entry;
    }

    /**
     * 获取设备日志
     * @param {string} deviceId - 设备ID
     * @param {Object} filter - 过滤条件
     * @returns {Array} 日志列表
     */
    getDeviceLogs(deviceId, filter = {}) {
        let logs = deviceLogs.get(deviceId) || [];

        if (filter.level) {
            logs = logs.filter(l => l.level === filter.level);
        }

        if (filter.since) {
            const timestamp = new Date(filter.since).getTime();
            logs = logs.filter(l => l.timestamp >= timestamp);
        }

        if (filter.limit) {
            logs = logs.slice(0, filter.limit);
        }

        return logs;
    }

    /**
     * 注册设备
     * @param {Object} deviceData - 设备数据
     * @param {Object} AgentRuntime - AgentRuntime实例
     * @param {WebSocket} ws - WebSocket连接
     * @returns {Promise<Object>} 设备对象
     */
    async registerDevice(deviceData, AgentRuntime, ws) {
        const runtimeBot = this.getBot(AgentRuntime);
        const {
            device_id,
            device_type,
            device_name,
            capabilities = [],
            metadata = {},
            ip_address,
            firmware_version
        } = deviceData;

        const validation = validateDeviceRegistration(deviceData);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        const existedDevice = devices.get(device_id);
        const systemConfig = getSystemConfig();
        const now = Date.now();
        const heartbeatTimeoutMs = (systemConfig.heartbeat?.timeout || 1800) * 1000;

        // 若在心跳超时时间内重复 register，视为“心跳/快速重连”，避免频繁上下线事件与日志
        const isWithinHeartbeatWindow = existedDevice
          ? (now - (existedDevice.last_seen || 0)) <= heartbeatTimeoutMs
          : false;

        const device = {
            device_id,
            device_type,
            device_name: device_name || `${device_type}_${device_id}`,
            capabilities,
            metadata,
            ip_address: ip_address || ws?.remoteAddress || ws?._socket?.remoteAddress || existedDevice?.ip_address,
            firmware_version,
            online: true,
            last_seen: now,
            registered_at: existedDevice?.registered_at || now,
            stats: existedDevice?.stats || {
                messages_sent: 0,
                messages_received: 0,
                commands_executed: 0,
                errors: 0,
                reconnects: existedDevice
                  ? existedDevice.stats.reconnects + (isWithinHeartbeatWindow ? 0 : 1)
                  : 0
            }
        };

        devices.set(device_id, device);

        if (!deviceLogs.has(device_id)) {
            deviceLogs.set(device_id, []);
        }

        if (!deviceStats.has(device_id)) {
            this.initDeviceStats(device_id);
        }

        if (ws) {
            this.setupWebSocket(device_id, ws);
        }

        if (!runtimeBot.uin.includes(device_id)) {
            runtimeBot.uin.push(device_id);
        }

        this.createDeviceBot(device_id, device, ws, runtimeBot);

        const wasOffline = existedDevice ? existedDevice.online === false : false;
        const isFirstSeen = !existedDevice;
        // 若短时间内重复注册（如前端自动重连），仅更新 last_seen，不再重复“上线”广播
        const shouldAnnounceOnline = isFirstSeen || (wasOffline && !isWithinHeartbeatWindow);

        if (shouldAnnounceOnline) {
            RuntimeUtil.makeLog('info',
                `🟢 [设备上线] ${device.device_name} (${device_id}) - IP: ${device.ip_address || '未知'}`,
                device.device_name
            );

            // 标准化事件系统: 触发设备上线事件
            const onlineEventData = {
                post_type: 'device',
                event_type: 'online',
                device_id,
                device_type,
                device_name: device.device_name,
                capabilities,
                self_id: device_id,
                time: Math.floor(Date.now() / 1000)
            };
            runtimeBot.em('device.online', onlineEventData);
        } else {
            RuntimeUtil.makeLog('debug',
                `↻ [设备重连] ${device.device_name} (${device_id})`,
                device.device_name
            );
        }

        return device;
    }

    /**
     * 设置WebSocket连接
     * @param {string} deviceId - 设备ID
     * @param {WebSocket} ws - WebSocket实例
     */
    setupWebSocket(deviceId, ws) {
        const oldWs = deviceWebSockets.get(deviceId);
        if (oldWs && oldWs !== ws) {
            clearInterval(oldWs.heartbeatTimer);
            try {
                if (oldWs.readyState === 1) {
                    oldWs.close();
                } else {
                    oldWs.terminate();
                }
            } catch {
                // 忽略错误
            }
        }

        ws.device_id = deviceId;
        ws.remoteAddress = ws.remoteAddress
            || ws._socket?.remoteAddress
            || ws._socket?.address?.()?.address
            || 'unknown';
        ws.isAlive = true;
        ws.lastPong = Date.now();
        ws.messageQueue = [];

        const systemConfig = getSystemConfig();
        ws.heartbeatTimer = setInterval(() => {
        const device = devices.get(deviceId);
            const now = Date.now();

            if (device && device.online) {
                const timeSinceLastSeen = now - (device.last_seen || 0);
                const heartbeatTimeoutMs = (systemConfig.heartbeat?.timeout || 1800) * 1000;

                // 主判断：基于心跳/last_seen 的超时控制（完全由配置 heartbeat.timeout 决定）
                if (timeSinceLastSeen > heartbeatTimeoutMs) {
                    this.handleDeviceDisconnect(deviceId, ws);
                    return;
                }
            }

            // 对非 Web 设备，使用 websocket.pongTimeout 做底层连接健康检查；
            // Web 客户端前端已有自动重连策略，这里不再基于 pong 额外判离线，避免与前端冲突。
            if (device && device.device_type !== 'web' && !ws.isAlive && ws.lastPong) {
                const basePongTimeoutMs = systemConfig.websocket?.pongTimeout || 10000;
                const pongTimeoutMs = basePongTimeoutMs * 3;

                if ((now - ws.lastPong) > pongTimeoutMs) {
                    this.handleDeviceDisconnect(deviceId, ws);
                    return;
                }
            }

            ws.isAlive = false;

            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'heartbeat_request',
                        timestamp: Date.now()
                    }));
                } catch {
                    // 忽略错误
                }
            }
        }, (systemConfig.heartbeat?.interval || 30) * 1000);

        ws.on('pong', () => {
        ws.isAlive = true;
            ws.lastPong = Date.now();
            this.updateDeviceStats(deviceId, 'heartbeat');
        });

        ws.on('error', (error) => {
        RuntimeUtil.makeLog('error',
                `❌ [WebSocket错误] ${error.message}`,
                deviceId
            );
        });

        deviceWebSockets.set(deviceId, ws);
    }

    /**
     * 处理设备断开连接
     * @param {string} deviceId - 设备ID
     * @param {WebSocket} ws - WebSocket实例
     */
    handleDeviceDisconnect(deviceId, ws) {
        clearInterval(ws.heartbeatTimer);

        const device = devices.get(deviceId);
        const runtimeBot = this.bot;
        if (device) {
            device.online = false;
            const logLevel = device.device_type === 'web' ? 'debug' : 'info';
            RuntimeUtil.makeLog(
                logLevel,
                `🔴 [设备离线] ${device.device_name} (${deviceId})`,
                device.device_name
            );

            if (runtimeBot) {
                    // 标准化事件系统: 触发设备离线事件
                    const offlineEventData = {
                        post_type: 'device',
                        event_type: 'offline',
                        device_id: deviceId,
                        device_type: device.device_type,
                        device_name: device.device_name,
                        self_id: deviceId,
                        time: Math.floor(Date.now() / 1000)
                    };
                    runtimeBot.em('device.offline', offlineEventData);
            }
        }

        deviceWebSockets.delete(deviceId);
    }

    /**
     * 创建设备AgentRuntime实例
     * @param {string} deviceId - 设备ID
     * @param {Object} deviceInfo - 设备信息
     * @param {WebSocket} ws - WebSocket实例
     * @returns {Object} AgentRuntime实例
     */
    createDeviceBot(deviceId, deviceInfo, ws, botOverride) {
        const runtimeBot = this.getBot(botOverride);
        // 确保设备名称，Web客户端使用友好名称
        const deviceName = deviceInfo.device_type === 'web' 
          ? 'Web客户端' 
          : (deviceInfo.device_name || `${deviceInfo.device_type}_${deviceId}`);
        
    const deviceBot = {
            tasker: this,
            ws,
            uin: deviceId,
            nickname: deviceName,
            avatar: null,
            info: {
                ...deviceInfo,
                device_name: deviceName
            },
            device_type: deviceInfo.device_type,
            capabilities: deviceInfo.capabilities || [],
            metadata: deviceInfo.metadata || {},
            online: true,
            last_seen: Date.now(),
            stats: {
                messages_sent: 0,
                messages_received: 0,
                commands_executed: 0,
                errors: 0,
                reconnects: 0
            },

            addLog: (level, message, data = {}) =>
                this.addDeviceLog(deviceId, level, message, data),

            getLogs: (filter = {}) => this.getDeviceLogs(deviceId, filter),

            clearLogs: () => deviceLogs.set(deviceId, []),

            sendMsg: async (msg) => {
        const emotion = findEmotionFromKeywords(msg);
                if (emotion) {
                    return await this.sendCommand(deviceId, 'display_emotion', { emotion }, 1);
                }
                return await this.sendCommand(
                    deviceId,
                    'display',
                    {
                        text: msg,
                        x: 0,
                        y: 0,
                        font_size: 16,
                        wrap: true,
                        spacing: 2
                    },
                    1
                );
            },

            /** 以聊天回复形式发到 Web 客户端（Event/聊天窗口展示），与事件里的 reply 同格式 */
            reply: async (segmentsOrText) => {
        const ws = deviceWebSockets.get(deviceId);
                if (!ws || ws.readyState !== WebSocket.OPEN) return false;
                try {
                    const text = typeof segmentsOrText === 'string' ? segmentsOrText : (segmentsOrText?.segments?.[0]?.text ?? String(segmentsOrText ?? ''));
                    const replyMsg = {
                        type: 'reply',
                        device_id: deviceId,
                        channel: 'device',
                        timestamp: Date.now(),
                        message_id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        segments: [{ type: 'text', text }]
                    };
                    ws.send(JSON.stringify(replyMsg));
                    return true;
                } catch (err) {
                    RuntimeUtil.makeLog('error', `reply失败: ${err.message}`, deviceId);
                    return false;
                }
            },

            sendCommand: async (cmd, params = {}, priority = 0) =>
                await this.sendCommand(deviceId, cmd, params, priority),

            // TTS音频发送：带后端背压（按 ws.bufferedAmount 排队/限速），避免一下子全发导致前端挤压/丢包
            // 同一设备维度串行发送，不阻塞上游
            // 优先使用二进制传输（借鉴 xiaozhi）：hex 转 ArrayBuffer 直接发送，带宽约减半、解析更快
            sendAudioChunk: (hex) => {
        const ws = deviceWebSockets.get(deviceId);
                if (ws && ws.readyState === WebSocket.OPEN && typeof hex === 'string' && hex.length > 0) {
                    const bytes = hex.length / 2;

                    try {
                        // 初始化每个ws的发送链（串行化）
                        if (!ws.__ttsSendChain) {
                            ws.__ttsSendChain = Promise.resolve();
                        }
                        // 背压阈值：更激进，尽量让前端队列保持很浅（嵌入式设备风格）
                        const MAX_BUFFERED = 128 * 1024; // 再收紧到 128KB，减少浏览器端缓存
                        const LOW_BUFFERED = 32 * 1024;   // 32KB 以下视为“安全”
                        const WAIT_STEP_MS = 5;           // 更细颗粒轮询
                        const MAX_WAIT_MS = 2000;         // 最多等待 2 秒，防止极端阻塞
                        // 前端队列水位：控制在 4 帧左右（约 240ms）以内，更贴近嵌入式“几帧窗口”
                        const HIGH_WATER = 4;
                        const LOW_WATER = 1;
                        const STATUS_STALE_MS = 800;      // 状态超过 800ms 视为过期，避免旧水位误判

                        ws.__ttsSendChain = ws.__ttsSendChain.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;

                            const startWait = Date.now();
                            while (ws.readyState === WebSocket.OPEN) {
                                const status = ttsQueueStatus.get(deviceId);
                                const statusFresh = status && (Date.now() - status.ts) <= STATUS_STALE_MS;
                                const queueTooHigh = statusFresh && typeof status.queueLen === 'number' && status.queueLen >= HIGH_WATER;
                                const bufferedTooHigh = ws.bufferedAmount > MAX_BUFFERED;

                                if (!queueTooHigh && !bufferedTooHigh) break;
                                if (Date.now() - startWait > MAX_WAIT_MS) break;
                                await new Promise(r => setTimeout(r, WAIT_STEP_MS));

                                // 如果前端队列从高水位回落到低水位附近，尽快放行
                                if (statusFresh && status.queueLen <= LOW_WATER && ws.bufferedAmount <= LOW_BUFFERED) break;
                            }

                            // 如果 still 很大，再给一次短等待，避免尖峰
                            if (ws.bufferedAmount > LOW_BUFFERED) {
                                await new Promise(r => setTimeout(r, WAIT_STEP_MS));
                            }

                            // xiaozhi 风格：纯二进制 TTS，稳定快速
                            const buf = Buffer.from(hex, 'hex');
                            ws.send(buf);
                            RuntimeUtil.makeLog(
                                'debug',
                                (() => {
        const status = ttsQueueStatus.get(deviceId);
                                    const q = status ? status.queueLen : 'N/A';
                                    return `[TTS传输] 二进制发送: 字节=${bytes}, buffered=${ws.bufferedAmount}, 前端队列=${q}`;
                                })(),
                                deviceId
                            );
                        }).catch((e) => {
        RuntimeUtil.makeLog('error', `[TTS传输] WebSocket发送队列异常: ${e.message}`, deviceId);
                        });
                    } catch (e) {
                        RuntimeUtil.makeLog('error', `[TTS传输] WebSocket发送失败: ${e.message}`, deviceId);
                    }
                } else {
                    if (!ws) {
                        RuntimeUtil.makeLog('warn', `[TTS传输] WebSocket未找到设备: ${deviceId}`, deviceId);
                    } else if (ws.readyState !== WebSocket.OPEN) {
                        RuntimeUtil.makeLog('warn', `[TTS传输] WebSocket未打开: ${deviceId}, 状态=${ws.readyState}`, deviceId);
                    }
                }
            },

            display: async (text, options = {}) =>
                await this.sendCommand(
                    deviceId,
                    'display',
                    {
                        text,
                        x: options.x || 0,
                        y: options.y || 0,
                        font_size: options.font_size || 16,
                        wrap: options.wrap !== false,
                        spacing: options.spacing || 2
                    },
                    1
                ),

            emotion: async (emotionName) => {
        if (!SUPPORTED_EMOTIONS.includes(emotionName)) {
                    throw new Error(`未知表情: ${emotionName}`);
                }
                return await this.sendCommand(
                    deviceId,
                    'display_emotion',
                    { emotion: emotionName },
                    1
                );
            },

            clear: async () =>
                await this.sendCommand(deviceId, 'display_clear', {}, 1),

            camera: {
                startStream: async (options = {}) =>
                    await this.sendCommand(deviceId, 'camera_start_stream', {
                        fps: options.fps || 10,
                        quality: options.quality || 12,
                        resolution: options.resolution || 'VGA'
                    }, 1),
                stopStream: async () =>
                    await this.sendCommand(deviceId, 'camera_stop_stream', {}, 1),
                capture: async () =>
                    await this.sendCommand(deviceId, 'camera_capture', {}, 1),
            },

            microphone: {
                getStatus: async () =>
                    await this.sendCommand(deviceId, 'microphone_status', {}, 0),
                start: async () =>
                    await this.sendCommand(deviceId, 'microphone_start', {}, 1),
                stop: async () =>
                    await this.sendCommand(deviceId, 'microphone_stop', {}, 1),
            },

            reboot: async () =>
                await this.sendCommand(deviceId, 'reboot', {}, 99),

            hasCapability: (cap) => hasCapability(deviceInfo, cap),

            getStatus: () => {
        const device = devices.get(deviceId);
                return {
                    device_id: deviceId,
                    device_name: deviceInfo.device_name,
                    device_type: deviceInfo.device_type,
                    online: device?.online || false,
                    last_seen: device?.last_seen,
                    capabilities: deviceInfo.capabilities,
                    metadata: deviceInfo.metadata,
                    stats: device?.stats || runtimeBot[deviceId].stats
                };
            },

      getStats: () =>
        deviceStats.get(deviceId) || this.initDeviceStats(deviceId)
    };

    // 通过 AgentRuntime 代理注册设备子 AgentRuntime（进入 bots 映射，而不是直接挂载到主实例上）
    runtimeBot[deviceId] = deviceBot;

    return deviceBot;
    }

    /**
     * 发送命令到设备
     * @param {string} deviceId - 设备ID
     * @param {string} command - 命令名称
     * @param {Object} parameters - 命令参数
     * @param {number} priority - 优先级
     * @returns {Promise<Object>} 命令结果
     */
    async sendCommand(deviceId, command, parameters = {}, priority = 0) {
        const device = devices.get(deviceId);
        if (!device) {
            throw new Error('设备未找到');
        }

        const systemConfig = getSystemConfig();

        const cmd = {
            id: generateCommandId(),
            command,
            parameters,
            priority,
            timestamp: Date.now()
        };

        this.updateDeviceStats(deviceId, 'command');

        const ws = deviceWebSockets.get(deviceId);

        if (ws && ws.readyState === WebSocket.OPEN) {
            return new Promise((resolve) => {
        const timeout = setTimeout(() => {
        commandCallbacks.delete(cmd.id);
                    resolve({ success: true, command_id: cmd.id, timeout: true });
                }, systemConfig.command?.timeout || 5000);

                commandCallbacks.set(cmd.id, (result) => {
        clearTimeout(timeout);
                    resolve({ success: true, command_id: cmd.id, result });
                });

                try {
                    ws.send(JSON.stringify({ type: 'command', command: cmd }));
                    device.stats.commands_executed++;
                } catch (e) {
                    clearTimeout(timeout);
                    commandCallbacks.delete(cmd.id);
                    resolve({ success: false, command_id: cmd.id, error: e.message });
                }
            });
        }

        const queue = deviceCommands.get(deviceId) || [];
        if (priority > 0) {
            queue.unshift(cmd);
        } else {
            queue.push(cmd);
        }

        const maxQueueSize = systemConfig.messageQueue?.size || 100;
        if (queue.length > maxQueueSize) {
            queue.length = maxQueueSize;
        }

        deviceCommands.set(deviceId, queue);
        device.stats.commands_executed++;

        return { success: true, command_id: cmd.id, queued: queue.length };
    }

    /** 标记设备活跃（OneBot 风格：心跳/消息/通知统一更新） */
    markDeviceActive(ws, deviceId) {
        if (ws) ws.isAlive = true; if (ws) ws.lastPong = Date.now();
        const device = devices.get(deviceId);
        if (device) {
            device.last_seen = Date.now();
            device.online = true;
        }
    }

    /** 向 WebSocket 发送错误响应 */
    sendWsError(ws, message) {
        try {
            ws.send(JSON.stringify({ type: 'error', message }));
        } catch {}
    }

    /**
     * 处理WebSocket消息
     * @param {WebSocket} ws - WebSocket实例
     * @param {Object} data - 消息数据
     * @param {Object} AgentRuntime - AgentRuntime实例
     * @returns {Promise<void>}
     */
    async processWebSocketMessage(ws, data, AgentRuntime) {
        const runtimeBot = this.getBot(AgentRuntime);
        try {
            const { type, device_id, ...payload } = data;
            const deviceId = device_id || ws.device_id || 'unknown';

            const isWeb = deviceId === 'webclient' || String(deviceId).startsWith('webclient_');
            if (type !== 'heartbeat' && type !== 'heartbeat_response') {
                const label = isWeb ? `收到 ${type}` : type;
                logWithThrottle('info', `📨 [WebSocket] ${label}`, deviceId, `ws:${deviceId}:${type}`, 800);
            }

            if (!type) {
                RuntimeUtil.makeLog('error', `❌ [WebSocket] 消息格式错误，缺少type字段`, deviceId);
                this.sendWsError(ws, '消息格式错误：缺少type字段');
                return;
            }
            if (type !== 'register' && !devices.has(deviceId)) {
                RuntimeUtil.makeLog('warn', `[WebSocket] 收到来自未注册设备的消息 (type: ${type})`, deviceId);
                this.sendWsError(ws, '设备未注册。请先发送 register 消息。');
                return;
            }

            switch (type) {
                case 'register': {
                    ws.device_id = deviceId;
                    const device = await this.registerDevice(
                        { device_id: deviceId, user_id: payload.user_id, ...payload },
                        runtimeBot,
                        ws
                    );
                    ws.send(JSON.stringify({
                        type: 'register_response',
                        success: true,
                        device
                    }));
                    break;
                }

                case 'asr_session_start':
                    await this.handleASRSessionStart(deviceId, payload);
                    break;

                case 'asr_audio_chunk':
                    await this.handleASRAudioChunk(deviceId, payload);
                    break;

                case 'asr_session_stop':
                    await this.handleASRSessionStop(deviceId, payload);
                    break;

                case 'log': {
                    const { level = 'info', message, data: logData } = payload;
                    this.addDeviceLog(deviceId, level, message, logData);
                    break;
                }

                // 前端TTS队列状态上报：用于后端实时限流/背压
                case 'tts_queue_status': {
                    const queueLen = Number(payload.queue_len ?? payload.queueLen ?? 0);
                    const playing = payload.playing === true;
                    const activeSources = Number(payload.active_sources ?? payload.activeSources ?? 0);
                    const ts = Number(payload.ts ?? Date.now());
                    ttsQueueStatus.set(deviceId, { queueLen, playing, activeSources, ts: Date.now(), clientTs: ts });
                    break;
                }

                case 'heartbeat': {
                    this.markDeviceActive(ws, deviceId);
                    const hbDevice = devices.get(deviceId);
                    if (hbDevice && payload.status) hbDevice.status = payload.status;
                    this.updateDeviceStats(deviceId, 'heartbeat');

                    const queued = deviceCommands.get(deviceId) || [];
                    const toSend = queued.splice(0, 3);

                    ws.send(JSON.stringify({
                        type: 'heartbeat_response',
                        commands: toSend,
                        timestamp: Date.now()
                    }));
                    break;
                }

                case 'heartbeat_response': {
                    this.markDeviceActive(ws, deviceId);
                    this.updateDeviceStats(deviceId, 'heartbeat');
                    break;
                }

                case 'command_result': {
                    const { command_id, result } = payload;
                    const callback = commandCallbacks.get(command_id);
                    if (callback) {
                        callback(result);
                        commandCallbacks.delete(command_id);
                    }
                    break;
                }

                case 'notice': {
                    const device = devices.get(deviceId);
                    if (!device) break;
                    this.markDeviceActive(ws, deviceId);
                    const notice_type = payload.notice_type || 'notify';
                    const sub_type = payload.sub_type || '';
                    const user_id = payload.user_id || payload.userId || deviceId;
                    const now = Math.floor(Date.now() / 1000);
                    const noticeEventData = {
                        post_type: 'notice',
                        notice_type: notice_type,
                        sub_type: sub_type,
                        device_id: deviceId,
                        device_type: device.device_type,
                        device_name: device.device_name,
                        self_id: deviceId,
                        user_id,
                        isMaster: payload.isMaster === true || (payload.device_type === 'web' && user_id),
                        time: now,
                        event_id: `device_notice_${now}_${Math.random().toString(36).substr(2, 9)}`,
                        tasker: 'device',
                        isDevice: true,
                        bot: runtimeBot[deviceId]
                    };
                    runtimeBot.em('device.notice', noticeEventData);
                    runtimeBot.em('device', noticeEventData);
                    break;
                }

                case 'message': {
                    const device = devices.get(deviceId);
                    if (!device) break;
                    this.markDeviceActive(ws, deviceId);
                    device.stats.messages_received++;
                    this.updateDeviceStats(deviceId, 'message');

                    const text = payload.text || (typeof payload.message === 'string' ? payload.message : '') || '';
                    const user_id = payload.user_id || payload.userId || deviceId;
                    const isMaster = payload.isMaster === true || (payload.device_type === 'web' && user_id);
                    
                    // 确保 message 是数组格式
                    let message = payload.message;
                    if (!Array.isArray(message)) {
                        if (typeof message === 'string') {
                            message = [{ type: 'text', text: message }];
                        } else {
                            message = [{ type: 'text', text }];
                        }
                    }
                    
                    const messagePayload = {
                        text,
                        message,
                        sender: payload.sender || { nickname: payload.nickname || 'web' },
                        user_id,
                        channel: payload.channel || 'web-chat',
                        meta: payload.meta || {},
                        isMaster
                    };

                    const eventId = `device_message_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                    const now = Math.floor(Date.now() / 1000);
                    pushDeviceChatMessage(deviceId, {
                        user_id,
                        nickname: messagePayload.sender?.nickname || messagePayload.sender?.card || 'web',
                        message: text,
                        message_id: eventId,
                        time: now
                    });

                    const deviceEventData = {
                        post_type: 'message',
                        message_type: 'private',
                        device_id: deviceId,
                        device_type: device.device_type,
                        device_name: device.device_name,
                        event_data: messagePayload,
                        self_id: deviceId,
                        user_id,
                        isMaster,
                        time: now,
                        event_id: eventId,
                        message_id: eventId,
                        tasker: 'device',
                        isDevice: true,
                        bot: runtimeBot[deviceId],
                        message: messagePayload.message,
                        raw_message: text,
                        msg: text,
                        sender: messagePayload.sender,
                        channel: messagePayload.channel,
                        meta: messagePayload.meta,
                        /** 与 QQ 一致：供 ChatStream.syncHistoryFromAdapter 拉取近期对话并参与 LLM 上下文。签名 (message_seq, count, reverseOrder) */
                        getChatHistory: (_message_seq, count = 20, _reverseOrder) =>
                            getDeviceChatHistory(deviceId, count),
                        /** 获取当前消息所回复的那条（从 message 中第一个 reply 段解析），便于插件处理媒体等 */
                        getReply: async () => {
        const msg = messagePayload.message;
                            const seg = Array.isArray(msg) ? msg.find(s => s && s.type === 'reply') : null;
                            if (!seg) return null;
                            return {
                                id: seg.id ?? seg.message_id,
                                message_id: seg.id ?? seg.message_id,
                                text: seg.text ?? seg.content ?? '',
                                raw_message: seg.text ?? seg.raw_message ?? seg.content ?? '',
                                message: Array.isArray(seg.message) ? seg.message : [],
                                sender: seg.sender
                            };
                        },
                        /**
                         * 回复消息到 web 客户端
                         * 
                         * 职责：
                         * 1. 接收 tasker 发送的 segments（标准格式）
                         * 2. 将文件路径转换为 web 可访问的 URL
                         * 3. 通过 WebSocket 发送到 web 客户端
                         * 
                         * Tasker 标准格式：
                         * - 字符串：'text'
                         * - Segment 对象：{ type: 'text', text: '...' } 或 { type: 'image', data: { file: '...' } }
                         * - Segment 数组：['text', { type: 'image', ... }]
                         * - 包含 segments 的对象：{ segments: [...], title: '...', description: '...' }
                         * 
                         * @param {string|Array|Object} segmentsOrText - Tasker 发送的消息内容
                         * @returns {Promise<boolean>} 是否发送成功
                         */
                        reply: async (segmentsOrText) => {
        try {
                                const ws = deviceWebSockets.get(deviceId);
                                if (!ws || ws.readyState !== WebSocket.OPEN) {
                                    RuntimeUtil.makeLog('warn', `[WebSocket] 连接未打开，无法发送消息`, deviceId);
                                    return false;
                                }
                                
                                // 标准化输入：tasker 发送的 segments 格式
                                let segments = [];
                                let title = '';
                                let description = '';
                                
                                if (Array.isArray(segmentsOrText)) {
                                    // 检查数组的第一个元素是否是包含segments的对象（可能是replyData被错误包装成数组）
                                    if (segmentsOrText.length === 1 && segmentsOrText[0] && typeof segmentsOrText[0] === 'object' && segmentsOrText[0].segments) {
                                        // 提取replyData对象
                                        const replyData = segmentsOrText[0];
                                        segments = replyData.segments;
                                        title = replyData.title || '';
                                        description = replyData.description || '';
                                    } else {
                                    // 数组：直接使用，标准化字符串为 text segment
                                    segments = segmentsOrText.map(seg =>
                                        typeof seg === 'string' ? { type: 'text', text: seg } : seg
                                    );
                                    }
                                } else if (segmentsOrText && typeof segmentsOrText === 'object') {
                                    if (segmentsOrText.segments) {
                                        // 包含 segments 的对象（用于传递 title/description）
                                        segments = segmentsOrText.segments;
                                        title = segmentsOrText.title || '';
                                        description = segmentsOrText.description || '';
                                    } else if (segmentsOrText.type && ['text', 'image', 'video', 'record', 'file', 'at', 'reply', 'raw', 'markdown'].includes(segmentsOrText.type)) {
                                        segments = [segmentsOrText];
                                    } else {
                                        segments = [{ type: 'text', text: String(segmentsOrText) }];
                                    }
                                } else if (segmentsOrText) {
                                    segments = [{ type: 'text', text: String(segmentsOrText) }];
                                }

                                // 处理 segments：路径/Buffer 转 web URL
                                segments = segments.map((seg) => {
        // 字符串类型：转换为 text segment（防御性处理）
                                    if (typeof seg === 'string') {
                                        return { type: 'text', text: seg };
                                    }
                                    
                                    if (!seg || typeof seg !== 'object') {
                                        return seg;
                                    }
                                    
                                    // 转发消息类型：直接返回，保持结构（forward类型包含data.messages）
                                    if (seg.type === 'forward') {
                                        return seg;
                                    }
                                    
                                    // node类型：保持原样（转发消息的组成部分）
                                    if (seg.type === 'node') {
                                        return seg;
                                    }
                                    
                                    // 文本段：标准化格式
                                    if (seg.type === 'text') {
                                        const text = seg.text || (seg.data?.text) || '';
                                        return text ? { type: 'text', text } : null;
                                    }
                                    
                                    // at 类型：标准化格式，确保qq和name字段
                                    if (seg.type === 'at') {
                                        return {
                                            type: 'at',
                                            qq: seg.qq || seg.user_id || '',
                                            name: seg.name || ''
                                        };
                                    }
                                    
                                    // 特殊类型：保持原样（reply/markdown/raw/button）
                                    if (['reply', 'markdown', 'raw', 'button'].includes(seg.type)) {
                                        return seg;
                                    }
                                    // 戳一戳：与 chat 私聊/设备协议一致，原样下发给前端
                                    if (seg.type === 'poke') {
                                        return { type: 'poke', qq: seg.qq ?? seg.user_id ?? '' };
                                    }
                                    // 文件类型：Buffer 转 data URL，路径转 web URL
                                    if (['image', 'video', 'record', 'file'].includes(seg.type)) {
                                        if (seg.url) return seg;
                                        const filePath = seg.file || seg.data?.file;
                                        if (Buffer.isBuffer(filePath)) {
                                            const mime = seg.type === 'image' ? (filePath[0] === 0x89 && filePath[1] === 0x50 ? 'image/png' : 'image/jpeg') : seg.type === 'video' ? 'video/mp4' : 'application/octet-stream';
                                            return { type: seg.type, url: `data:${mime};base64,${filePath.toBase64()}`, data: {}, name: seg.name };
                                        }
                                        if (!filePath || typeof filePath !== 'string') {
                                            RuntimeUtil.makeLog('warn', `[reply] ${seg.type} segment 缺少 file 或 url`, deviceId);
                                            return null;
                                        }
                                        if (/^https?:\/\//i.test(filePath) || filePath.startsWith('data:')) {
                                            return { type: seg.type, url: filePath, data: { file: filePath }, name: seg.name };
                                        }
                                        const normalizedPath = path.normalize(filePath);
                                        const trashPath = path.normalize(paths.trash);
                                        const url = normalizedPath.startsWith(trashPath)
                                            ? `/api/trash/${path.relative(trashPath, normalizedPath).replace(/\\/g, '/')}`
                                            : path.isAbsolute(filePath)
                                                ? `/api/device/file/${Buffer.from(filePath, 'utf8').toBase64({ alphabet: 'base64url' })}`
                                                : `/api/trash/${filePath.replace(/\\/g, '/')}`;
                                        return { type: seg.type, url, data: { file: filePath }, name: seg.name };
                                    }
                                    
                                    // 其他类型 segment：直接返回
                                    return seg;
                                }).filter(seg => seg !== null);

                                if (segments.length === 0) {
                                    RuntimeUtil.makeLog('warn', `[回复消息] segments为空，无法发送`, deviceId);
                                    return false;
                                }
                                
                                // 检查是否为转发消息（聊天记录）
                                const isForward = segments.length === 1 && segments[0] && (
                                    segments[0].type === 'forward' ||
                                    (segments[0].data?.messages && Array.isArray(segments[0].data.messages)) ||
                                    (segments[0].messages && Array.isArray(segments[0].messages))
                                );
                                
                                const replyMsg = {
                                    type: isForward ? 'forward' : 'reply',
                                    device_id: deviceId,
                                    channel: messagePayload.channel || 'device',
                                    timestamp: Date.now(),
                                    message_id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                                };
                                let replyTextForHistory = '';
                                if (isForward) {
                                    // 转发消息：提取messages数组
                                    let forwardData = null;
                                    if (segments[0].data?.messages && Array.isArray(segments[0].data.messages)) {
                                        forwardData = segments[0].data.messages;
                                    } else if (segments[0].messages && Array.isArray(segments[0].messages)) {
                                        forwardData = segments[0].messages;
                                    } else if (segments[0].type === 'node' && segments[0].data) {
                                        forwardData = [segments[0]];
                                    } else {
                                        forwardData = segments[0].data?.messages || segments[0].messages;
                                        if (!Array.isArray(forwardData)) {
                                            forwardData = [segments[0]];
                                        }
                                    }
                                    
                                    // 验证并发送转发消息
                                    if (Array.isArray(forwardData) && forwardData.length > 0) {
                                        replyMsg.messages = forwardData;
                                        if (title) replyMsg.title = title;
                                        if (description) replyMsg.description = description;
                                        replyTextForHistory = title || description || `[转发消息 ${forwardData.length}条]`;
                                        RuntimeUtil.makeLog('info', 
                                            `📨 [转发消息] ${forwardData.length}条消息${title ? ` - ${title}` : ''}`, 
                                            deviceId
                                        );
                                    } else {
                                        RuntimeUtil.makeLog('warn', `[转发消息] 格式错误，降级为普通消息`, deviceId);
                                        replyMsg.type = 'reply';
                                        replyMsg.segments = segments;
                                        if (title) replyMsg.title = title;
                                        if (description) replyMsg.description = description;
                                    }
                                } else {
                                    // 普通消息：使用 segments 格式
                                    replyMsg.segments = segments;
                                if (title) replyMsg.title = title;
                                if (description) replyMsg.description = description;
                                
                                const logText = segments.map(seg => {
                                    if (seg.type === 'text') return seg.text || (seg.data && seg.data.text) || '';
                                    if (seg.type === 'image') return '[图片]';
                                    if (seg.type === 'record') return '[语音]';
                                    if (seg.type === 'poke') return '[戳一戳]';
                                    return '';
                                }).join('');
                                replyTextForHistory = logText || '';
                                if (logText) {
                                    RuntimeUtil.makeLog('info', 
                                        `${title ? `【${title}】` : ''}${logText.substring(0, 500)}${logText.length > 500 ? '...' : ''}`, 
                                        deviceId
                                    );
                                    }
                                }
                                
                                ws.send(JSON.stringify(replyMsg));
                                if (replyTextForHistory) {
                                    pushDeviceChatMessage(deviceId, {
                                        user_id: 'assistant',
                                        nickname: '助手',
                                        message: replyTextForHistory,
                                        message_id: replyMsg.message_id,
                                        time: Math.floor(Date.now() / 1000)
                                    });
                                }
                                return true;
                            } catch (err) {
                                RuntimeUtil.makeLog('error', `reply失败: ${err.message}`, deviceId);
                                return false;
                            }
                        }
                    };
                    
                    runtimeBot.em('device.message', deviceEventData);
                    runtimeBot.em('device', deviceEventData);
                    break;
                }

                // 约定：客户端发送 { type: 'data', data_type: 'xxx', data: {...} }
                case 'data': {
                    const device = devices.get(deviceId);
                    if (!device) break;
                    this.markDeviceActive(ws, deviceId);
                    this.updateDeviceStats(deviceId, 'data');

                    const dataType = payload.data_type || payload.dataType || payload.kind || 'data';
                    const raw = payload.data;
                    const dataPayload = (raw && typeof raw === 'object') ? raw : { value: raw };
                    const user_id = payload.user_id || payload.userId || deviceId;
                    const now = Math.floor(Date.now() / 1000);
                    const eventId = `device_data_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                    // 通用 data 事件：event_data 包含 data_type + dataPayload（展开），便于插件直接读取字段（如 beacons）
                    const dataEvent = {
                        post_type: 'device',
                        event_type: 'data',
                        device_id: deviceId,
                        device_type: device.device_type,
                        device_name: device.device_name,
                        self_id: deviceId,
                        user_id,
                        time: now,
                        event_id: eventId,
                        tasker: 'device',
                        isDevice: true,
                        bot: runtimeBot[deviceId],
                        event_data: {
                            data_type: dataType,
                            ...dataPayload
                        }
                    };

                    runtimeBot.em('device.data', dataEvent);
                    runtimeBot.em('device', dataEvent);

                    // 细分事件：device.<data_type>，event_data 仅为 dataPayload（保持最贴近原始上报）
                    const typedEvent = {
                        ...dataEvent,
                        event_id: `${eventId}_${dataType}`,
                        event_data: dataPayload,
                        data_type: dataType
                    };
                    runtimeBot.em(`device.${dataType}`, typedEvent);
                    break;
                }

                default:
                    // 只对非心跳类型的未知消息发送错误
                    if (type !== 'heartbeat_response') {
                        RuntimeUtil.makeLog('warn',
                            `⚠️ [WebSocket] 未知消息类型: ${type}`,
                            deviceId
                        );
                    }
            }
        } catch (e) {
            RuntimeUtil.makeLog('error', `❌ [WebSocket] 处理消息失败: ${e.message}`, ws.device_id);
            this.sendWsError(ws, e.message);
        }
    }

    /**
     * 检查离线设备
     * @param {Object} AgentRuntime - AgentRuntime实例
     */
    checkOfflineDevices(AgentRuntime) {
        const runtimeBot = this.getBot(AgentRuntime);
        const systemConfig = getSystemConfig();
        const timeout = (systemConfig.heartbeat?.timeout || 1800) * 1000;
        const now = Date.now();

        for (const [id, device] of devices) {
            if (!device.online || now - device.last_seen <= timeout) continue;

            const ws = deviceWebSockets.get(id);

            if (ws) {
                this.handleDeviceDisconnect(id, ws);
                continue;
            }

            device.online = false;

            RuntimeUtil.makeLog('info',
                `🔴 [设备离线] ${device.device_name} (${id})`,
                device.device_name
            );

            runtimeBot.em('device.offline', {
                post_type: 'device',
                event_type: 'offline',
                device_id: id,
                device_type: device.device_type,
                device_name: device.device_name,
                self_id: id,
                time: Math.floor(Date.now() / 1000)
            });
        }
    }

    /**
     * 获取设备列表
     * @returns {Array} 设备列表
     */
    getDeviceList() {
        return Array.from(devices.values()).map(d => ({
            device_id: d.device_id,
            device_name: d.device_name,
            device_type: d.device_type,
            online: d.online,
            last_seen: d.last_seen,
            capabilities: d.capabilities,
            stats: d.stats
        }));
    }

    /**
     * 获取设备信息
     * @param {string} deviceId - 设备ID
     * @returns {Object|null} 设备信息
     */
    getDevice(deviceId) {
        const device = devices.get(deviceId);
        if (!device) return null;

        return {
            ...device,
            device_stats: deviceStats.get(deviceId)
        };
    }
}

// ==================== 创建设备管理器实例 ====================
const deviceManager = new DeviceManager();

// ==================== 导出模块 ====================
export default {
    name: 'device',
    dsc: '设备管理API v31.0 - 连续对话优化版',
    priority: 90,

    routes: [
        {
            method: 'POST',
            path: '/api/device/register',
            handler: HttpResponse.asyncHandler(async (req, res, AgentRuntime) => {
                    const device = await deviceManager.registerDevice(
                        {
                            ...req.body,
                            ip_address: req.ip || req.socket.remoteAddress
                        },
                        AgentRuntime
                    );
                HttpResponse.success(res, { device_id: device.device_id });
            }, 'device.register')
        },

        {
            method: 'POST',
            path: '/api/device/:deviceId/ai',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const deviceId = req.params.deviceId;
                    const { text, workflow, persona, profile, llm, model, llmProfile } = req.body || {};
                    if (!text || !String(text).trim()) {
                    return HttpResponse.validationError(res, '缺少文本内容');
                    }
                    const device = deviceManager.getDevice(deviceId);
                    if (!device) {
                    return HttpResponse.notFound(res, '设备未找到');
                    }
                    const workflowName = (workflow || 'device').toString().trim() || 'device';
                    await deviceManager._processAIResponse(deviceId, String(text), {
                        workflow: workflowName,
                        persona,
                        profile: llmProfile || profile || llm || model,
                        fromASR: false
                    });
                HttpResponse.success(res);
            }, 'device.ai')
        },

        {
            method: 'GET',
            path: '/api/devices',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const list = deviceManager.getDeviceList();
                HttpResponse.success(res, { devices: list, count: list.length });
            }, 'device.list')
        },

        {
            method: 'GET',
            path: '/api/device/:deviceId',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const device = deviceManager.getDevice(req.params.deviceId);
                if (device) {
                    HttpResponse.success(res, { device });
                } else {
                    HttpResponse.notFound(res, '设备未找到');
                }
            }, 'device.get')
        },

        {
            method: 'GET',
            path: '/api/device/:deviceId/asr/sessions',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const sessions = Array.from(asrSessions.entries())
                    .filter(([, s]) => s.deviceId === req.params.deviceId)
                    .map(([sid, s]) => ({
                        session_id: sid,
                        device_id: s.deviceId,
                        session_number: s.sessionNumber,
                        total_chunks: s.totalChunks,
                        total_bytes: s.totalBytes,
                        started_at: s.startTime,
                        elapsed: ((Date.now() - s.startTime) / 1000).toFixed(1),
                    }));

                HttpResponse.success(res, { sessions, count: sessions.length });
            }, 'device.asr.sessions')
        },

        {
            method: 'GET',
            path: '/api/device/:deviceId/asr/recordings',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const recordings = await getAudioFileList(
                        deviceManager.AUDIO_SAVE_DIR,
                        req.params.deviceId
                    );

                HttpResponse.success(res, {
                        recordings,
                        count: recordings.length,
                        total_size: recordings.reduce((s, r) => s + r.size, 0)
                    });
            }, 'device.asr.recordings')
        },

        {
            method: 'POST',
            path: '/api/device/tts',
            handler: HttpResponse.asyncHandler(async (req, res) => {
        const { device_id, text } = req.body || {};
                if (!text || !String(text).trim()) {
                    return HttpResponse.validationError(res, '缺少文本内容');
                }
                if (!device_id) {
                    return HttpResponse.validationError(res, '缺少设备ID');
                }

                const ttsConfig = getTtsConfig();
                if (!ttsConfig.enabled) {
                    return HttpResponse.error(res, new Error('TTS未启用'), 400, 'device.tts');
                }

                try {
                    const ttsClient = deviceManager._getTTSClient(device_id, ttsConfig);
                    const success = await ttsClient.synthesize(String(text).trim());
                    if (success) {
                        HttpResponse.success(res, { message: 'TTS合成已启动' });
                    } else {
                        HttpResponse.error(res, new Error('TTS合成失败'), 500, 'device.tts');
                    }
                } catch (e) {
                    HttpResponse.error(res, e, 500, 'device.tts');
                }
            }, 'device.tts')
        },

        {
            method: 'GET',
            path: '/api/trash/*',
            handler: HttpResponse.asyncHandler(async (req, res) => {
                const filePath = req.params[0];
                if (!filePath || filePath.includes('..')) {
                    return HttpResponse.validationError(res, '无效的文件路径');
                }

                let resolvedPath;
                try {
                    resolvedPath = InputValidator.validatePath(filePath, paths.trash);
                } catch (e) {
                    return HttpResponse.validationError(res, e.message || '无效的文件路径');
                }

                if (!fs.existsSync(resolvedPath)) {
                    return HttpResponse.notFound(res, '文件不存在');
                }

                const ext = path.extname(resolvedPath).toLowerCase();
                const contentTypeMap = {
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.svg': 'image/svg+xml'
                };

                const contentType = contentTypeMap[ext] || 'application/octet-stream';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=3600');

                fs.createReadStream(resolvedPath).pipe(res);
            }, 'trash.file')
        },
        {
            method: 'GET',
            path: '/api/device/file/:fileId',
            handler: HttpResponse.asyncHandler(async (req, res) => {
                const fileId = req.params.fileId;
                if (!fileId) {
                    return HttpResponse.validationError(res, '文件ID不能为空');
                }

                let filePath;
                try {
                    filePath = Buffer.from(Uint8Array.fromBase64(fileId, { alphabet: 'base64url' })).toString('utf8');
                } catch {
                    return HttpResponse.validationError(res, '无效的文件ID');
                }

                let normalizedPath;
                try {
                    normalizedPath = InputValidator.assertPathUnderRoots(filePath, DEVICE_FILE_ROOTS);
                } catch (e) {
                    const msg = e.message || '无效的文件路径';
                    if (msg.includes('拒绝')) {
                        return HttpResponse.forbidden(res, msg);
                    }
                    return HttpResponse.validationError(res, msg);
                }

                if (!fs.existsSync(normalizedPath)) {
                    return HttpResponse.notFound(res, '文件不存在');
                }

                const stats = fs.statSync(normalizedPath);
                if (!stats.isFile()) {
                    return HttpResponse.validationError(res, '路径不是文件');
                }

                const ext = path.extname(normalizedPath).toLowerCase();
                const contentTypeMap = {
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.svg': 'image/svg+xml',
                    '.bmp': 'image/bmp',
                    '.ico': 'image/x-icon'
                };

                const contentType = contentTypeMap[ext] || 'application/octet-stream';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.setHeader('Content-Disposition', `inline; filename="${path.basename(normalizedPath)}"`);

                fs.createReadStream(normalizedPath).pipe(res);
            }, 'device.file')
        }
    ],

    ws: {
        device: [
            (ws, req, AgentRuntime) => {
        const remote = req.socket?.remoteAddress || req.headers['x-real-ip'] || 'unknown';
                if (shouldLogConnection(remote)) {
                    RuntimeUtil.makeLog('info',
                        `🔌 [WebSocket] 新连接: ${remote}`,
                        'DeviceManager'
                    );
                }

                ws.on('message', msg => {
                    try {
                        const data = JSON.parse(msg);
                        deviceManager.processWebSocketMessage(ws, data, AgentRuntime);
                    } catch (e) {
                        RuntimeUtil.makeLog('error',
                            `❌ [WebSocket] 消息解析失败: ${e.message}`,
                            ws.device_id
                        );
                    }
                });

                ws.on('close', () => {
        if (ws.device_id) {
                        deviceManager.handleDeviceDisconnect(ws.device_id, ws);
                    } else {
                        RuntimeUtil.makeLog('info',
                            `✓ [WebSocket] 连接关闭: ${remote}`,
                            'DeviceManager'
                        );
                    }
                });

                ws.on('error', (e) => {
        RuntimeUtil.makeLog('error',
                        `❌ [WebSocket] 错误: ${e.message}`,
                        ws.device_id || 'unknown'
                    );
                });
            }
        ]
    },

    init(app, AgentRuntime) {
        if (__runtime) __runtime.dispose();
        __runtime = new Disposables();
        deviceManager.setBot(AgentRuntime);
        deviceManager.cleanupInterval = __runtime.interval(() => {
        deviceManager.checkOfflineDevices();
        }, 30000);

        __runtime.interval(() => {
        const now = Date.now();
            for (const [id, _] of commandCallbacks) {
                const timestamp = parseInt(id.split('_')[0]);
                if (now - timestamp > 60000) {
                    commandCallbacks.delete(id);
                }
            }
        }, 60000);

        __runtime.interval(() => {
        const now = Date.now();
            for (const [sessionId, session] of asrSessions) {
                if (now - session.lastChunkTime > 5 * 60 * 1000) {
                    try {
                        const client = asrClients.get(session.deviceId);
                        if (client) {
                            client.endUtterance().catch(() => { });
                        }
                    } catch {
                        // 忽略错误
                    }
                    asrSessions.delete(sessionId);
                }
            }
        }, 5 * 60 * 1000);

        // 订阅ASR结果事件：更新会话finalText并转发中间结果到前端
        try {
            deviceManager.attachDeviceEventBridge(deviceManager.getBot());
        } catch {
            // 忽略挂接失败，通常是 AgentRuntime 尚未完全初始化
        }
    },

    destroy() {
        deviceManager.detachDeviceEventBridge();
        if (__runtime) __runtime.dispose();
        __runtime = null;

        for (const [, ws] of deviceWebSockets) {
            try {
                clearInterval(ws.heartbeatTimer);
                if (ws.readyState === 1) {
                    ws.close();
                } else {
                    ws.terminate();
                }
            } catch {
                // 忽略错误
            }
        }

        for (const [, client] of asrClients) {
            try {
                client.destroy();
            } catch {
                // 忽略错误
            }
        }

        for (const [, client] of ttsClients) {
            try {
                client.destroy();
            } catch {
                // 忽略错误
            }
        }

        asrSessions.clear();
    },

    stop() {
        return this.destroy();
    }
};