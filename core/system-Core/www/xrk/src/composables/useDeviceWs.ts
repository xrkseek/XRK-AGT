import { onUnmounted, ref, shallowRef } from 'vue';
import type { LoosePayload } from '@/types';

/** WebSocket 上挂的设备标识（对齐原 app 行为） */
interface DeviceSocket extends WebSocket {
  device_id?: string;
}

export type DeviceWsStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface DeviceWsHandlers {
  onOpen?: () => void;
  onBinary?: (data: ArrayBuffer) => void;
  onMessage?: (data: LoosePayload) => void;
  onClose?: (event: CloseEvent) => void;
}
import { getServerUrl } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

/**
 * 设备 WebSocket（Event / Voice 通道）
 * 对齐原 app.ensureDeviceWs：register + heartbeat + 文本消息
 */
export function useDeviceWs(handlers: DeviceWsHandlers = {}) {
  const status = ref<DeviceWsStatus>('idle');
  const lastError = ref('');
  const wsRef = shallowRef<DeviceSocket | null>(null);
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;
  let webUserId = localStorage.getItem('webUserId') || '';

  function getWebUserId(): string {
    if (!webUserId) {
      webUserId = `webclient_${Date.now()}`;
      try {
        localStorage.setItem('webUserId', webUserId);
      } catch {
        /* ignore */
      }
    }
    return webUserId;
  }

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function release(): void {
    intentionalClose = true;
    clearTimers();
    const ws = wsRef.value;
    wsRef.value = null;
    status.value = 'closed';
    if (!ws) return;
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close(1000, 'released');
    } catch {
      /* ignore */
    }
  }

  function ensure(): void {
    const state = wsRef.value?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    intentionalClose = false;
    status.value = 'connecting';
    lastError.value = '';

    const auth = useAuthStore();
    const apiKey = auth.apiKey || '';
    const base = getServerUrl();
    const protocol = base.startsWith('https') ? 'wss' : 'ws';
    const host = base.replace(/^https?:\/\//, '');
    const wsUrl = `${protocol}://${host}/device${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}`;
    const deviceId = getWebUserId();

    try {
      const ws: DeviceSocket = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.value = ws;

      ws.onopen = () => {
        status.value = 'open';
        ws.device_id = deviceId;
        ws.send(
          JSON.stringify({
            type: 'register',
            device_id: deviceId,
            device_type: 'web',
            device_name: 'Web客户端',
            capabilities: ['display', 'microphone'],
            user_id: deviceId,
          }),
        );
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
            } catch {
              /* ignore */
            }
          }
        }, 30000);
        handlers.onOpen?.();
      };

      ws.onmessage = (e) => {
        try {
          if (e.data instanceof ArrayBuffer) {
            handlers.onBinary?.(e.data as ArrayBuffer);
            return;
          }
          const data = JSON.parse(e.data);
          handlers.onMessage?.(data as LoosePayload);
        } catch (err) {
          console.warn('[device-ws] parse', err);
        }
      };

      ws.onclose = (event) => {
        clearTimers();
        wsRef.value = null;
        status.value = 'closed';
        handlers.onClose?.(event);
        if (!intentionalClose && event.code !== 1000) {
          reconnectTimer = setTimeout(() => ensure(), event.code === 1006 ? 3000 : 5000);
        }
      };

      ws.onerror = () => {
        lastError.value = '连接错误';
        status.value = 'closed';
      };
    } catch (err) {
      status.value = 'closed';
      lastError.value = (err as Error)?.message || String(err);
    }
  }

  function sendJson(payload: LoosePayload): boolean {
    const ws = wsRef.value;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ensure();
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

  function devicePayloadBase(): LoosePayload {
    const deviceId = getWebUserId();
    return {
      device_id: deviceId,
      device_type: 'web',
      user_id: deviceId,
      isMaster: true,
      channel: 'web-chat',
    };
  }

  function sendChatMessage(text: string, meta: LoosePayload = {}): boolean {
    return sendJson({
      type: 'message',
      ...devicePayloadBase(),
      content: text,
      text,
      ...meta,
    });
  }

  /** 对齐原 sendDeviceNotice（戳一戳等） */
  function sendDeviceNotice(
    notice_type: string,
    sub_type: string,
    payload: LoosePayload = {},
  ): boolean {
    return sendJson({
      type: 'notice',
      ...devicePayloadBase(),
      notice_type,
      sub_type,
      ...payload,
    });
  }

  onUnmounted(release);

  return {
    status,
    lastError,
    wsRef,
    ensure,
    release,
    sendJson,
    sendChatMessage,
    sendDeviceNotice,
    getWebUserId,
  };
}
