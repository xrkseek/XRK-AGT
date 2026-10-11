/**
 * Voice TTS：对齐原 app._sendTTSChunk / _handleBinaryTTS（PCM16 @ 16kHz）
 */
import { getServerUrl } from '@/api/client';
import type { LoosePayload } from '@/types';

/** createVoiceTts 的依赖注入 */
export interface VoiceTtsDeps {
  getDeviceId?: () => string;
  getWs?: () => WebSocket | null;
  onStatus?: (status: string) => void;
}

/** 全局 vendor 前缀的 AudioContext（Safari） */
interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function stripMarkdownForTTS(text: unknown = ''): string {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~|>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createVoiceTts({ getDeviceId, getWs, onStatus }: VoiceTtsDeps = {}) {
  let audioCtx: AudioContext | null = null;
  let playing = false;
  let stoppedManually = false;
  let sessionActive = false;
  let textQueue: string[] = [];
  let audioQueue: AudioBuffer[] = [];
  let activeSources: AudioBufferSourceNode[] = [];
  let nextPlayTime = 0;
  let prebufferTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(s: string): void {
    onStatus?.(s);
  }

  function stop(): void {
    stoppedManually = true;
    textQueue = [];
    audioQueue = [];
    playing = false;
    sessionActive = false;
    nextPlayTime = 0;
    if (prebufferTimer) {
      clearTimeout(prebufferTimer);
      prebufferTimer = null;
    }
    for (const src of activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    activeSources = [];
    setStatus('播报已停止');
  }

  async function ensureCtx(): Promise<AudioContext> {
    const AC =
      window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AC) throw new Error('浏览器不支持 Web Audio');
    if (!audioCtx) {
      audioCtx = new AC({ sampleRate: 16000 });
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return audioCtx;
  }

  async function requestTts(text: string): Promise<void> {
    const deviceId = getDeviceId?.();
    if (!deviceId || !text?.trim()) return;
    stoppedManually = false;
    textQueue.push(text.trim());
    if (!sessionActive) void processTextQueue();
  }

  async function processTextQueue(): Promise<void> {
    if (!textQueue.length || sessionActive) return;
    const parts: string[] = [];
    let len = 0;
    while (textQueue.length && parts.length < 5 && len < 150) {
      const t = textQueue.shift() as string;
      parts.push(t);
      len += t.length;
      if (/[。！？.!?]$/.test(t) && len >= 30) break;
    }
    const merged = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!merged) {
      void processTextQueue();
      return;
    }
    sessionActive = true;
    setStatus('TTS 合成中…');
    try {
      await fetch(`${getServerUrl()}/api/device/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceIdSafe(), text: merged }),
      });
      await new Promise((r) => setTimeout(r, 80));
    } catch (err) {
      console.warn('[TTS]', err);
      sessionActive = false;
      void processTextQueue();
    }
  }

  function deviceIdSafe(): string {
    return getDeviceId?.() || '';
  }

  function onSessionEnd(): void {
    sessionActive = false;
    if (textQueue.length) void processTextQueue();
    else setStatus('点击麦克风开始对话');
  }

  async function handleBinary(arrayBuffer: ArrayBuffer): Promise<void> {
    if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer) || !arrayBuffer.byteLength) return;
    if (stoppedManually) return;
    try {
      const ctx = await ensureCtx();
      const bytes = new Uint8Array(arrayBuffer);
      // 期望 PCM s16le mono；若长度奇数则丢弃末字节
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount <= 0) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
      const buffer = ctx.createBuffer(1, sampleCount, 16000);
      const channel = buffer.getChannelData(0);
      const scale = 1 / 32768;
      for (let i = 0; i < sampleCount; i++) {
        channel[i] = view.getInt16(i * 2, true) * scale;
      }
      audioQueue.push(buffer);
      reportQueue();
      if (!playing) {
        if (audioQueue.length >= 1) {
          playing = true;
          nextPlayTime = 0;
          playNext();
        }
      }
    } catch (err) {
      console.error('[TTS] decode', err);
    }
  }

  function playNext(): void {
    if (!audioQueue.length) {
      playing = false;
      nextPlayTime = 0;
      if (!activeSources.length) onSessionEnd();
      return;
    }
    const ctx = audioCtx;
    if (!ctx) return;
    const buf = audioQueue.shift() as AudioBuffer;
    const start = nextPlayTime === 0 ? ctx.currentTime : Math.max(ctx.currentTime, nextPlayTime);
    nextPlayTime = start + buf.duration;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, start);
    source.connect(gain);
    gain.connect(ctx.destination);
    activeSources.push(source);
    source.onended = () => {
      const i = activeSources.indexOf(source);
      if (i >= 0) activeSources.splice(i, 1);
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        /* ignore */
      }
      playNext();
    };
    try {
      source.start(start);
      setStatus('播报中…');
    } catch (err) {
      console.warn('[TTS] start', err);
      playNext();
    }
  }

  function reportQueue(): void {
    const ws = getWs?.();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: 'tts_queue_status',
          device_id: deviceIdSafe(),
          queue_len: audioQueue.length,
          playing,
          active_sources: activeSources.length,
          ts: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
  }

  function handleWsMessage(data: LoosePayload): void {
    if (!data || typeof data !== 'object') return;
    const t = data.type;
    if (t === 'tts_session_end' || t === 'tts_end' || t === 'tts_done') {
      // 等音频播完再结束；若队列已空则立刻结束
      if (!playing && !audioQueue.length && !activeSources.length) onSessionEnd();
    }
  }

  return {
    requestTts,
    handleBinary,
    handleWsMessage,
    stop,
    get playing() {
      return playing;
    },
  };
}
