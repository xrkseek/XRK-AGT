<script>
export default { name: 'ChatView' };
</script>

<script setup>
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NInput,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui';
import { apiFetch, authHeaders, getServerUrl } from '@/api/client';
import { abortTimeout, copyText } from '@/utils/http';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import {
  endpointMetaText,
  getLlmVendors,
  getVendorEndpoints,
  normalizeWorkspaceId,
  persistAiLlmSelection,
  resolveAiLlmSelection,
  validateChatProviderForFactory,
} from '@/chat/llm-settings';
import AiWorkspacePanel from '@/components/AiWorkspacePanel.vue';
import ChatBubble from '@/components/ChatBubble.vue';
import XrkIcon from '@/components/XrkIcon.vue';
import { useDeviceWs } from '@/composables/useDeviceWs';
import { useListPaneWidth } from '@/composables/useListPaneWidth';
import { useViewport } from '@/composables/useViewport';
import { createVoiceTts, stripMarkdownForTTS } from '@/chat/voice-tts';
import {
  extractForwardLines,
  extractSegments,
  isAckOnlyText,
  resolveMediaUrl,
  segmentsToPlainText,
} from '@/chat/segments';
import { makeHistoryMessage } from '@/chat/history';
import {
  clearStoredChatScroll,
  isNearBottom,
  scrollChatToBottom,
} from '@/chat/scroll';
import {
  compressImageFile,
  createAttachItem,
  fileToBase64,
  formatBytes,
  revokeAttachItem,
} from '@/chat/attach';
import { liveSegments, parseV3Stream } from '@/chat/stream';
import { toolsMayTouchWorkspace } from '@/chat/tools';
import { downloadImage } from '@/chat/markdown';
import { useRouter } from 'vue-router';

const message = useMessage();
const chat = useChatStore();
const auth = useAuthStore();
const router = useRouter();
const { isMobile } = useViewport();
const { width: listPaneW, startResize } = useListPaneWidth();

const input = ref('');
const streaming = ref(false);
/** Event 已发出、等 WS 回包（不锁输入） */
const awaitingReply = ref(false);
const settingsOpen = ref(true);
const listEl = ref(null);
const fileInputEl = ref(null);
const loadingOpts = ref(false);
const wsPanel = ref(null);
const voiceStatus = ref('点麦克风开始');
const voiceEmotion = ref('happy');
const headerEmotion = ref('happy');
const micActive = ref(false);
const previewUrl = ref('');
const attachments = ref([]);
const dragOver = ref(false);
/** 手机端侧栏开关 */
const sideOpen = ref(false);
/** 贴底跟随：上翻读历史时关掉，回到底部附近再开 */
const stickBottom = ref(true);
/** Event 引用：{ id, text } */
const eventQuote = ref(null);
let abortCtrl = null;
let asrSessionId = null;
let audioCtxMic = null;
let micStream = null;
let micProcessor = null;
let micSource = null;
/** @type {ReturnType<typeof createVoiceTts> | null} */
let voiceTts = null;
const processedIds = new Set();
let eventPendingTimer = null;
const modeOptions = [
  { value: 'event', label: 'Event' },
  { value: 'voice', label: 'Voice' },
  { value: 'ai', label: 'AI' },
];

const emotionGlyph = {
  happy: '●',
  think: '◐',
  message: '◆',
  sad: '✕',
  listen: '◎',
};

const statusLabel = computed(() => {
  if (streaming.value) return '生成中';
  if (awaitingReply.value) return '等待回复';
  if (micActive.value) return '聆听中';
  return '空闲';
});
const statusType = computed(() => {
  if (streaming.value) return 'warning';
  if (awaitingReply.value) return 'info';
  if (micActive.value) return 'warning';
  return 'success';
});
const busy = computed(() => streaming.value);
const canStop = computed(() => streaming.value || awaitingReply.value);
const headerTitle = computed(() => {
  if (chat.mode === 'ai') return 'AI 对话';
  if (chat.mode === 'event') return 'Event 对话';
  return 'Voice';
});

function setVoiceEmotion(key) {
  voiceEmotion.value = key in emotionGlyph ? key : 'happy';
  if (chat.mode !== 'voice') headerEmotion.value = voiceEmotion.value;
}

function setHeaderEmotion(key) {
  headerEmotion.value = key in emotionGlyph ? key : 'happy';
}

function extractWsText(data) {
  const segs = extractSegments(data);
  return segmentsToPlainText(segs);
}

function rememberMsgId(data) {
  const id =
    data?.message_id ||
    data?.event_id ||
    `${data?.type}_${data?.timestamp || ''}_${JSON.stringify(data || {}).slice(0, 48)}`;
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 800) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }
  return false;
}

function pushSegments(role, segments, extra = {}) {
  const segs = (segments || []).filter(Boolean);
  if (!segs.length) return null;
  const msg = makeHistoryMessage(role, { segments: segs, extra });
  messages.value = [...messages.value, msg];
  chat.persistHistory();
  scrollBottom(role === 'user');
  return msg;
}

function push(role, content) {
  const text = String(content ?? '');
  return pushSegments(role, text ? [{ type: 'text', text }] : []);
}

function replaceLastAssistant(patch) {
  const list = [...messages.value];
  const last = list[list.length - 1];
  if (!last || last.role !== 'assistant') return;
  const next = { ...last, ...patch };
  if (patch.content != null && patch.segments == null) {
    next.text = patch.content;
    next.content = patch.content;
    next.segments = patch.content ? [{ type: 'text', text: patch.content }] : [];
  }
  if (Array.isArray(patch.segments)) {
    next.segments = patch.segments;
    next.text = patch.text ?? segmentsToPlainText(patch.segments);
    next.content = next.text;
  }
  list[list.length - 1] = next;
  messages.value = list;
}

function clearEventQuote() {
  eventQuote.value = null;
}

function quoteMsg(m) {
  eventQuote.value = {
    id: m.id,
    text: (m.text || m.content || segmentsToPlainText(m.segments) || '').slice(0, 500),
  };
}

function openRemoteMcpConfig() {
  try {
    localStorage.setItem('lastConfigName', 'system');
    localStorage.setItem('lastConfigChild', 'ai-workflow');
  } catch {
    /* ignore */
  }
  router.push({ name: 'config' });
}

function handleDevicePayload(data) {
  if (!data || typeof data !== 'object') return;
  if (rememberMsgId(data)) return;
  const t = data.type;

  if (t === 'register_ack' || t === 'heartbeat' || t === 'pong' || t === 'heartbeat_request') {
    if (t === 'heartbeat_request') {
      device.sendJson({ type: 'heartbeat_response', timestamp: Date.now() });
    }
    return;
  }
  voiceTts?.handleWsMessage(data);

  if (t === 'asr_interim' || t === 'stt_interim') {
    const text = (data.text || extractWsText(data) || '').trim();
    if (text) {
      input.value = text;
      if (chat.mode === 'voice') {
        voiceStatus.value = `识别中: ${text}`;
        setVoiceEmotion('listen');
      }
    }
    return;
  }
  if (t === 'asr_final' || t === 'stt' || t === 'stt_final') {
    const text = (data.text || extractWsText(data) || '').trim();
    if (!text) return;
    input.value = text;
    if (chat.mode === 'voice' && !streaming.value) {
      voiceStatus.value = '识别完成，发送中…';
      void sendVoice(text).then(() => {
        input.value = '';
      });
    }
    return;
  }
  if (t === 'tts') return;

  if (t === 'status' || t === 'typing') {
    if (chat.mode === 'voice') voiceStatus.value = data.text || data.message || '输入中…';
    return;
  }
  if (t === 'error') {
    const errText = data.message || data.text || '设备错误';
    message.error(errText);
    push('system', errText);
    return;
  }

  if (t === 'llm') {
    const text = String(data.text ?? '').trim();
    if (data.emotion) setHeaderEmotion(data.emotion);
    if (text) pushSegments('assistant', [{ type: 'text', text }]);
    return;
  }

  if (t === 'command') {
    const cmd = data.command || data.cmd;
    if (cmd === 'display_emotion' && data.params?.emotion) {
      setHeaderEmotion(data.params.emotion);
      if (chat.mode === 'voice') setVoiceEmotion(data.params.emotion);
    }
    if (data.text || data.message) {
      pushSegments('assistant', [{ type: 'text', text: data.text || data.message }]);
    }
    if (Array.isArray(data.mcp_tools) && data.mcp_tools.length) {
      pushSegments('assistant', [{ type: 'tools', tools: data.mcp_tools }]);
    }
    return;
  }

  if (t === 'forward') {
    if (chat.mode === 'ai') return;
    const lines = extractForwardLines(data);
    const msg = makeHistoryMessage('assistant', {
      text: data.title || data.description || '[转发消息]',
      extra: {
        type: 'record',
        title: data.title || '',
        description: data.description || '',
        messages: lines,
      },
    });
    messages.value = [...messages.value, msg];
    chat.persistHistory();
    clearEventPending();
    scrollBottom();
    return;
  }

  if (t === 'reply') {
    // 对齐原 handleWsMessage case 'reply'
    if (data.title || data.description) {
      if (chat.mode === 'ai') return;
      const lines = extractForwardLines(data);
      const textLines =
        lines.length ||
        extractSegments(data)
          .filter((s) => s.type === 'text')
          .map((s) => s.text);
      const media = extractSegments(data).filter((s) =>
        ['image', 'video', 'record', 'file'].includes(s.type),
      );
      if (textLines.length || data.title) {
        const msg = makeHistoryMessage('assistant', {
          text: data.title || '',
          extra: {
            type: 'record',
            title: data.title || '',
            description: data.description || '',
            messages: textLines.length ? textLines : [data.description || ''],
          },
        });
        messages.value = [...messages.value, msg];
      }
      if (media.length) pushSegments('assistant', media);
      if (Array.isArray(data.mcp_tools) && data.mcp_tools.length) {
        pushSegments('assistant', [{ type: 'tools', tools: data.mcp_tools }]);
      }
      chat.persistHistory();
      clearEventPending();
      scrollBottom();
      return;
    }
    let segments = extractSegments(data);
    if (!segments.length && data.text) segments = [{ type: 'text', text: data.text }];
    if (Array.isArray(data.mcp_tools) && data.mcp_tools.length) {
      segments = [...segments, { type: 'tools', tools: data.mcp_tools }];
    }
    if (!segments.length) return;
    if (chat.mode === 'ai') return;
    pushSegments('assistant', segments);
    clearEventPending();
    return;
  }

  // 无 type 但带 segments 的富媒体包
  if (Array.isArray(data.segments) && data.segments.length && t !== 'message') {
    if (chat.mode === 'ai') return;
    pushSegments('assistant', extractSegments(data));
    clearEventPending();
    return;
  }

  const text = extractWsText(data);
  if (!text || isAckOnlyText(text)) return;
  if (chat.mode === 'ai' || chat.mode === 'voice') return;
  pushSegments('assistant', [{ type: 'text', text }]);
  clearEventPending();
}

function clearEventPending() {
  if (eventPendingTimer) {
    clearTimeout(eventPendingTimer);
    eventPendingTimer = null;
  }
  awaitingReply.value = false;
}

function armEventPending() {
  clearEventPending();
  awaitingReply.value = true;
  eventPendingTimer = setTimeout(() => {
    awaitingReply.value = false;
    eventPendingTimer = null;
  }, 60000);
}

const device = useDeviceWs({
  onOpen() {
    if (chat.mode === 'voice') voiceStatus.value = '设备已连接';
  },
  onBinary(buf) {
    if (chat.mode === 'voice') voiceTts?.handleBinary(buf);
  },
  onMessage: handleDevicePayload,
});

voiceTts = createVoiceTts({
  getDeviceId: () => device.getWebUserId(),
  getWs: () => device.wsRef.value,
  onStatus: (s) => {
    voiceStatus.value = s;
  },
});
const needsDevice = computed(() => chat.mode === 'event' || chat.mode === 'voice');
const deviceStatusLabel = computed(() => {
  const s = device.status.value;
  if (s === 'open') return '设备已连接';
  if (s === 'connecting') return '设备连接中';
  return '设备未连接';
});
const deviceStatusType = computed(() => {
  const s = device.status.value;
  if (s === 'open') return 'success';
  if (s === 'connecting') return 'warning';
  return 'error';
});

function syncDeviceWs() {
  if (needsDevice.value) device.ensure();
  else device.release();
}

const messages = computed({
  get() {
    return chat.histories[chat.mode] || [];
  },
  set(v) {
    chat.histories[chat.mode] = v;
  },
});

const vendors = computed(() => getLlmVendors(chat.llmOptions || {}));
const factoryOptions = computed(() =>
  vendors.value.map((v) => ({
    label: `${v.label || v.id}${v.endpoints?.length ? '' : '（未配置端点）'}`,
    value: v.id,
  })),
);
const endpointOptions = computed(() => {
  const eps = getVendorEndpoints(vendors.value, chat.settings.llmFactory);
  const opts = [{ label: '继承 ai-workflow 默认', value: '' }];
  for (const ep of eps) {
    opts.push({
      label: ep.model ? `${ep.label || ep.key} · ${ep.model}` : ep.label || ep.key,
      value: ep.key,
    });
  }
  return opts;
});
const endpointDisabled = computed(
  () => !chat.settings.llmFactory || !getVendorEndpoints(vendors.value, chat.settings.llmFactory).length,
);
const endpointHint = computed(() =>
  endpointMetaText(chat.llmOptions || {}, chat.settings.llmFactory, chat.settings.provider),
);
const workspaceOptions = computed(() =>
  (chat.workspacePresets || []).map((w) => ({ label: w.label || w.id, value: w.id })),
);
const workflowOptions = computed(() =>
  (chat.llmOptions?.workflows || [])
    .map((w) => ({
      value: w.key || w.name || '',
      label: w.label || w.description || w.key || w.name || '',
    }))
    .filter((w) => w.value),
);

async function scrollBottom(force = false) {
  await nextTick();
  const box = listEl.value;
  if (!box) return;
  if (!force && !stickBottom.value) return;
  stickBottom.value = true;
  scrollChatToBottom(box);
}

function onMsgsScroll() {
  const box = listEl.value;
  if (!box) return;
  stickBottom.value = isNearBottom(box);
}

/** 图片等异步撑高后，若仍贴底则再跟一次 */
function onMsgsMediaLoad(e) {
  const t = e?.target;
  if (!t || (t.tagName !== 'IMG' && t.tagName !== 'VIDEO')) return;
  if (stickBottom.value) scrollChatToBottom(listEl.value);
}

function enterChatBottom() {
  stickBottom.value = true;
  clearStoredChatScroll();
  void scrollBottom(true);
}

function msgPlainText(m) {
  if (Array.isArray(m.segments) && m.segments.length) return segmentsToPlainText(m.segments);
  return m.text || m.content || '';
}

function openPreview(url) {
  previewUrl.value = resolveMediaUrl(url);
}

async function savePreview() {
  if (!previewUrl.value) return;
  try {
    await downloadImage(previewUrl.value);
    message.success('图片已保存');
  } catch (err) {
    message.error(`保存失败：${err?.message || err}`);
  }
}

function closePreview() {
  previewUrl.value = '';
}

function clearAttachments() {
  for (const a of attachments.value) revokeAttachItem(a);
  attachments.value = [];
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  const isAi = chat.mode === 'ai';
  const maxSize = isAi ? 10 * 1024 * 1024 : 100 * 1024 * 1024;
  const next = [...attachments.value];
  for (const file of files) {
    if (isAi && !file.type?.startsWith('image/')) {
      message.warning('AI 模式只能上传图片');
      continue;
    }
    if (file.size > maxSize) {
      message.warning(`${file.name} 超过 ${isAi ? '10' : '100'}MB 限制`);
      continue;
    }
    next.push(createAttachItem(file));
  }
  attachments.value = next;
}

function removeAttach(id) {
  const item = attachments.value.find((a) => a.id === id);
  if (item) revokeAttachItem(item);
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

function onFileInputChange(e) {
  addFiles(e.target?.files);
  if (e.target) e.target.value = '';
}

function onPaste(e) {
  if (chat.mode === 'voice') return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
}

function onDrop(e) {
  e.preventDefault();
  dragOver.value = false;
  if (chat.mode === 'voice') return;
  addFiles(e.dataTransfer?.files);
}

function sendPoke() {
  const qq = device.getWebUserId();
  pushSegments('user', [{ type: 'poke', qq, text: `戳了戳 ${qq}` }]);
  device.ensure();
  device.sendDeviceNotice('notify', 'poke', { user_id: qq });
}

async function copyMsg(m) {
  const text = msgPlainText(m);
  if (!text) {
    message.warning('无可复制内容');
    return;
  }
  const ok = await copyText(text);
  if (ok) message.success('已复制');
  else message.error('复制失败：浏览器限制或权限不足');
}

function deleteMsg(m) {
  const id = m.id;
  messages.value = messages.value.filter((x) => x.id !== id);
  chat.persistHistory();
  message.success(m.role === 'user' ? '消息已撤回' : '消息已删除');
}

async function regenerateMsg(m) {
  if (m.role !== 'assistant' || chat.mode !== 'ai' || streaming.value) return;
  const list = messages.value;
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx < 0) return;
  let userIdx = idx - 1;
  while (userIdx >= 0 && list[userIdx].role !== 'user') userIdx--;
  if (userIdx < 0) {
    message.warning('找不到对应的用户消息');
    return;
  }
  const userText = msgPlainText(list[userIdx]);
  messages.value = list.filter((x) => x.id !== m.id);
  chat.persistHistory();
  if (userText.trim()) {
    message.info('正在重新生成…');
    try {
      await sendAi(userText, { skipUserPush: true });
    } catch (err) {
      message.error(err?.message || String(err));
    }
  }
}

async function loadLlmOptions(force = false) {
  if (!force && chat.llmOptions?.vendors?.length) return;
  loadingOpts.value = true;
  try {
    const data = await apiFetch('/api/ai/models', { timeoutMs: 10000 });
    chat.llmOptions = {
      enabled: data?.enabled !== false,
      defaultProfile: data?.defaultProfile || '',
      persona: data?.persona || '',
      profiles: data?.profiles || [],
      vendors: data?.vendors || [],
      workflows: data?.workflows || [],
    };
    const sel = resolveAiLlmSelection(getLlmVendors(chat.llmOptions), chat.settings);
    if (sel.changed) persistAiLlmSelection(chat.settings, sel);
    else {
      chat.settings.llmFactory = sel.factoryId;
      chat.settings.provider = sel.endpointKey;
    }
    if (!chat.settings.persona && data?.persona) {
      chat.settings.persona = data.persona;
      chat.persistPersona();
    }
  } catch (err) {
    message.warning(err?.message || '加载 LLM 选项失败');
  } finally {
    loadingOpts.value = false;
  }
}

async function loadWorkspaces() {
  try {
    const data = await apiFetch('/api/ai/workspaces', { timeoutMs: 8000 });
    const list = data?.workspaces || [];
    chat.workspacePresets = list.length
      ? list
      : [
          { id: 'default', label: '默认工作区' },
          { id: 'project', label: '项目根目录' },
        ];
    if (!chat.settings.workspace) {
      chat.settings.workspace = normalizeWorkspaceId(data?.defaultId || 'default');
      chat.persistWorkspace();
    }
  } catch {
    chat.workspacePresets = [
      { id: 'default', label: '默认工作区' },
      { id: 'project', label: '项目根目录' },
    ];
  }
}

function onFactoryChange(factoryId) {
  const endpoints = getVendorEndpoints(vendors.value, factoryId);
  const nextProvider = endpoints.length === 1 ? endpoints[0].key : '';
  chat.setLlmSelection({ factoryId, endpointKey: nextProvider });
}

function onProviderChange(endpointKey) {
  chat.setLlmSelection({ factoryId: chat.settings.llmFactory, endpointKey });
}

async function sendAi(text, { skipUserPush = false } = {}) {
  streaming.value = true;
  const atts = [...attachments.value];
  clearAttachments();

  const userSegs = [];
  if (text) userSegs.push({ type: 'text', text });
  const imageParts = [];
  for (const a of atts) {
    if (!a.isImage) continue;
    try {
      const compressed = await compressImageFile(a.file);
      const b64 = await fileToBase64(compressed);
      userSegs.push({ type: 'image', url: b64, name: a.name });
      imageParts.push({ type: 'image_url', image_url: { url: b64 } });
    } catch {
      /* skip */
    }
  }
  if (!skipUserPush) {
    if (userSegs.length) pushSegments('user', userSegs);
    else push('user', text || '');
  }

  const assistant = makeHistoryMessage('assistant', { text: '' });
  messages.value = [...messages.value, assistant];

  const provider = validateChatProviderForFactory(chat.llmOptions, chat.settings);
  if (provider !== (chat.settings.provider || '')) {
    chat.settings.provider = provider;
    try {
      localStorage.setItem('chatProvider', provider);
    } catch {
      /* ignore */
    }
  }

  const persona = (chat.settings.persona || '').trim();
  const historyMsgs = messages.value
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.text || m.content || '' }));

  let userContent = text || '';
  if (imageParts.length) {
    userContent = [{ type: 'text', text: text || '' }, ...imageParts];
  }
  historyMsgs.push({ role: 'user', content: userContent });
  const finalMessages = persona
    ? [{ role: 'system', content: persona }, ...historyMsgs]
    : historyMsgs;

  const requestBody = {
    messages: finalMessages,
    stream: true,
    apiKey: auth.apiKey || undefined,
  };
  if (provider) requestBody.model = provider;
  const workflows = (chat.settings.workflows || []).filter(Boolean);
  if (workflows.length) requestBody.workflow = { workflows };
  requestBody.workspace = { id: normalizeWorkspaceId(chat.settings.workspace) };

  abortCtrl = new AbortController();
  const timeout = abortTimeout(120000);
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([abortCtrl.signal, timeout])
      : abortCtrl.signal;

  try {
    const res = await fetch(`${getServerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders({ 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${auth.apiKey || ''}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    const state = await parseV3Stream(res, {
      signal,
      onDelta: (_d, s) => {
        replaceLastAssistant({
          text: s.fullText,
          content: s.fullText,
          segments: liveSegments(s),
          mcpTools: s.mcpTools,
        });
        scrollBottom();
      },
      onTools: (tools) => {
        if (toolsMayTouchWorkspace(tools)) {
          wsPanel.value?.refresh?.({ silent: true });
        }
      },
      onError: (err) => {
        if (err?.name !== 'AbortError') message.error(err.message || String(err));
      },
    });

    if (state.error && state.error.name !== 'AbortError' && !state.fullText) {
      replaceLastAssistant({ content: `错误：${state.error.message}` });
    } else {
      const segs = state.segments?.length ? state.segments : liveSegments(state);
      replaceLastAssistant({
        text: state.fullText,
        content: state.fullText,
        segments: segs,
        mcpTools: state.mcpTools,
      });
    }
    chat.persistHistory();
    wsPanel.value?.refresh?.({ silent: true });
  } finally {
    streaming.value = false;
    abortCtrl = null;
    chat.persistHistory();
  }
}

async function sendEvent(text) {
  const atts = [...attachments.value];
  clearAttachments();

  const userSegs = [];
  if (eventQuote.value) {
    userSegs.push({
      type: 'reply',
      id: eventQuote.value.id,
      text: eventQuote.value.text,
    });
  }
  if (text) userSegs.push({ type: 'text', text });
  for (const a of atts) {
    try {
      if (a.isImage) {
        const b64 = await fileToBase64(a.file);
        userSegs.push({ type: 'image', url: b64, name: a.name });
      } else if (a.type?.startsWith('video/')) {
        const b64 = await fileToBase64(a.file);
        userSegs.push({ type: 'video', url: b64, name: a.name });
      } else if (a.type?.startsWith('audio/')) {
        const b64 = await fileToBase64(a.file);
        userSegs.push({ type: 'record', url: b64, name: a.name });
      } else {
        const b64 = await fileToBase64(a.file);
        userSegs.push({ type: 'file', url: b64, name: a.name, size: a.size });
      }
    } catch {
      userSegs.push({ type: 'text', text: `[文件] ${a.name}` });
    }
  }
  clearEventQuote();
  if (userSegs.length) pushSegments('user', userSegs);
  else push('user', text || '');

  armEventPending();
  try {
    device.ensure();
    const meta = { source: 'manual' };
    if (userSegs.length) meta.message = userSegs;
    let sent = device.sendChatMessage(text || ' ', meta);
    if (!sent) {
      await new Promise((r) => setTimeout(r, 700));
      sent = device.sendChatMessage(text || ' ', meta);
    }
    if (!sent) {
      const res = await fetch(`${getServerUrl()}/api/stdin/event`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          event_type: 'message',
          content: text,
          message: userSegs.length ? userSegs : undefined,
          json: true,
          user_info: { tasker: 'api' },
        }),
        signal: abortTimeout(60000),
      });
      const json = await res.json().catch(() => ({}));
      const segs = extractSegments(json);
      if (segs.length) {
        pushSegments('assistant', segs);
        clearEventPending();
      } else {
        const reply =
          json.message || json.reply || json.content || json.data?.message || '';
        if (reply && !isAckOnlyText(reply)) {
          push('assistant', typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2));
          clearEventPending();
        } else if (!res.ok) {
          push('assistant', `(HTTP ${res.status})`);
          clearEventPending();
        } else {
          const tip = makeHistoryMessage('system', {
            text: '已发送，等待设备回包',
          });
          messages.value = [...messages.value, tip];
        }
      }
    }
  } catch (err) {
    clearEventPending();
    throw err;
  }
}

async function sendVoice(text) {
  if (streaming.value) return;
  voiceTts?.stop();
  voiceStatus.value = 'AI 思考中…';
  setVoiceEmotion('think');
  streaming.value = true;
  push('user', text);

  const assistant = makeHistoryMessage('assistant', { text: '' });
  messages.value = [...messages.value, assistant];

  const provider = validateChatProviderForFactory(chat.llmOptions, chat.settings);
  if (provider !== (chat.settings.provider || '')) {
    chat.settings.provider = provider;
  }

  const historyMsgs = messages.value
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.text || m.content || '' }));
  historyMsgs.push({ role: 'user', content: text });

  const requestBody = {
    messages: historyMsgs,
    stream: true,
    apiKey: auth.apiKey || undefined,
  };
  if (provider) requestBody.model = provider;
  const workflows = (chat.settings.workflows || []).filter(Boolean);
  if (workflows.length) requestBody.workflow = { workflows };
  requestBody.workspace = { id: normalizeWorkspaceId(chat.settings.workspace) };

  abortCtrl = new AbortController();
  const timeout = abortTimeout(120000);
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([abortCtrl.signal, timeout])
      : abortCtrl.signal;

  try {
    device.ensure();
    const res = await fetch(`${getServerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders({ 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${auth.apiKey || ''}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    const state = await parseV3Stream(res, {
      signal,
      onDelta: (_d, s) => {
        replaceLastAssistant({
          text: s.fullText,
          content: s.fullText,
          segments: liveSegments(s),
          mcpTools: s.mcpTools,
        });
        setVoiceEmotion('message');
        scrollBottom();
      },
      onTools: (tools) => {
        if (toolsMayTouchWorkspace(tools)) {
          wsPanel.value?.refresh?.({ silent: true });
        }
      },
    });

    const full = state.fullText || '';
    const segs = state.segments?.length ? state.segments : liveSegments(state);
    replaceLastAssistant({
      text: full,
      content: full,
      segments: segs,
      mcpTools: state.mcpTools,
    });

    const ttsText = stripMarkdownForTTS(full);
    if (ttsText) {
      await voiceTts?.requestTts(ttsText);
      setVoiceEmotion('happy');
      voiceStatus.value = '对话完成';
    } else {
      voiceStatus.value = '无播报内容';
      setVoiceEmotion('happy');
    }
    setTimeout(() => {
      if (!streaming.value) voiceStatus.value = '点麦克风开始';
    }, 2000);
    chat.persistHistory();
  } catch (err) {
    setVoiceEmotion('sad');
    voiceStatus.value = '出错了，请重试';
    throw err;
  } finally {
    streaming.value = false;
    abortCtrl = null;
    chat.persistHistory();
  }
}

function floatTo16BitPCM(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function pcmToHex(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function stopMic() {
  micActive.value = false;
  if (micProcessor?._flushTimer) {
    clearInterval(micProcessor._flushTimer);
    micProcessor._flushTimer = null;
  }
  try {
    micProcessor?.disconnect();
    micSource?.disconnect();
  } catch {
    /* ignore */
  }
  micProcessor = null;
  micSource = null;
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
  if (audioCtxMic) {
    try {
      await audioCtxMic.close();
    } catch {
      /* ignore */
    }
    audioCtxMic = null;
  }
  if (asrSessionId) {
    device.sendJson({
      type: 'asr_session_stop',
      session_id: asrSessionId,
      device_id: device.getWebUserId(),
    });
    asrSessionId = null;
  }
  voiceStatus.value = '点麦克风开始';
  setVoiceEmotion('happy');
}

async function toggleMic() {
  if (micActive.value) {
    await stopMic();
    return;
  }
  if (streaming.value) {
    message.warning('请等待当前对话结束');
    return;
  }
  device.ensure();
  if (device.status.value !== 'open') {
    await new Promise((r) => setTimeout(r, 600));
  }
  if (device.status.value !== 'open') {
    message.error('设备通道未连接，无法启动麦克风 ASR');
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtxMic = new AC({ sampleRate: 16000 });
    micSource = audioCtxMic.createMediaStreamSource(micStream);
    const bufferSize = 4096;
    micProcessor = audioCtxMic.createScriptProcessor(bufferSize, 1, 1);
    asrSessionId = `asr_${Date.now()}`;
    device.sendJson({
      type: 'asr_session_start',
      session_id: asrSessionId,
      device_id: device.getWebUserId(),
      sample_rate: 16000,
      bits: 16,
      channels: 1,
    });
    let chunkIndex = 0;
    const pending = [];
    micProcessor.onaudioprocess = (e) => {
      if (!micActive.value || !asrSessionId) return;
      pending.push(floatTo16BitPCM(e.inputBuffer.getChannelData(0)));
    };
    const flush = () => {
      if (!micActive.value || !asrSessionId || !pending.length) return;
      const total = pending.reduce((n, a) => n + a.length, 0);
      const combined = new Int16Array(total);
      let off = 0;
      while (pending.length) {
        const part = pending.shift();
        combined.set(part, off);
        off += part.length;
      }
      device.sendJson({
        type: 'asr_audio_chunk',
        session_id: asrSessionId,
        device_id: device.getWebUserId(),
        chunk_index: chunkIndex++,
        vad_state: 'active',
        data: pcmToHex(combined),
      });
    };
    const flushTimer = setInterval(flush, 60);
    micProcessor._flushTimer = flushTimer;
    micSource.connect(micProcessor);
    micProcessor.connect(audioCtxMic.destination);
    micActive.value = true;
    voiceStatus.value = '正在听…再点结束';
    setVoiceEmotion('listen');
  } catch (err) {
    message.error(`麦克风失败：${err?.message || err}`);
    await stopMic();
  }
}

function stopVoiceTts() {
  voiceTts?.stop();
  clearChatStreamStateSafe();
}

function clearChatStreamStateSafe() {
  abortCtrl?.abort();
  streaming.value = false;
}

async function send() {
  const text = input.value.trim();
  const hasAtt = attachments.value.length > 0;
  if ((!text && !hasAtt) || streaming.value) return;
  if (!text && hasAtt && chat.mode === 'voice') return;
  input.value = '';
  try {
    if (chat.mode === 'ai') {
      await sendAi(text);
      wsPanel.value?.refresh?.({ silent: true });
    } else if (chat.mode === 'event') await sendEvent(text);
    else await sendVoice(text);
  } catch (err) {
    if (err?.name === 'AbortError') {
      push('assistant', '（已停止）');
      return;
    }
    message.error(err?.message || String(err));
    push('assistant', `错误：${err?.message || err}`);
  }
}

function stop() {
  abortCtrl?.abort();
  clearEventPending();
}

function clearChat() {
  stop();
  clearAttachments();
  clearEventQuote();
  clearEventPending();
  chat.clearHistory();
  clearStoredChatScroll(chat.mode);
  ensureSystemTip();
}

function tipForMode(m) {
  if (m === 'ai') return '选择工厂与工作区后发送。可粘贴图片。';
  if (m === 'event') return '走设备通道；可上传文件、引用、戳一戳。';
  return '语音：麦克风 ASR + AI 回复 + TTS 播报。';
}

function ensureSystemTip() {
  if (messages.value.length) return;
  const tip = makeHistoryMessage('system', { text: tipForMode(chat.mode) });
  chat.histories[chat.mode] = [tip];
}

function switchMode(next) {
  if (next === chat.mode) {
    sideOpen.value = false;
    return;
  }
  clearAttachments();
  clearEventQuote();
  chat.setMode(next);
  sideOpen.value = false;
}

function onWorkspaceChange(id) {
  chat.settings.workspace = normalizeWorkspaceId(id);
  chat.persistWorkspace();
}

function onPresets(list) {
  if (Array.isArray(list) && list.length) chat.workspacePresets = list;
}

watch(
  () => chat.mode,
  (m) => {
    ensureSystemTip();
    syncDeviceWs();
    void stopMic();
    enterChatBottom();
    if (m === 'ai' || m === 'voice') {
      void loadLlmOptions();
      void loadWorkspaces();
    }
    if (m === 'voice') {
      setVoiceEmotion('happy');
      voiceStatus.value = '点麦克风开始';
    }
  },
);

onMounted(async () => {
  ensureSystemTip();
  syncDeviceWs();
  enterChatBottom();
  if (chat.mode === 'ai' || chat.mode === 'voice') {
    await Promise.all([loadLlmOptions(), loadWorkspaces()]);
  }
});

onActivated(() => {
  syncDeviceWs();
  enterChatBottom();
});

onDeactivated(() => {
  void stopMic();
  device.release();
});
</script>

<template>
  <div
    class="chat-page"
    :class="{ 'is-dragover': dragOver, 'side-open': sideOpen, 'is-mobile-page': isMobile }"
    :style="{ '--list-pane-w': `${listPaneW}px` }"
    @dragover.prevent="dragOver = chat.mode !== 'voice'"
    @dragleave.prevent="dragOver = false"
    @drop="onDrop"
  >
    <div v-if="sideOpen" class="side-scrim" @click="sideOpen = false" />

    <aside class="chat-side brutal-card">
      <NSpace vertical size="small" style="width: 100%">
        <div class="mode-row">
          <button
            v-for="m in modeOptions"
            :key="m.value"
            type="button"
            class="mode-btn"
            :class="{ active: chat.mode === m.value }"
            @click="switchMode(m.value)"
          >
            {{ m.label }}
          </button>
        </div>

        <template v-if="chat.mode === 'ai'">
          <button type="button" class="settings-toggle" @click="settingsOpen = !settingsOpen">
            AI 设置 {{ settingsOpen ? '▾' : '▸' }}
          </button>
          <div v-show="settingsOpen" class="ai-settings">
            <label class="lbl">工作区</label>
            <NSelect
              size="small"
              :value="chat.settings.workspace"
              :options="workspaceOptions"
              :loading="loadingOpts"
              @update:value="onWorkspaceChange"
            />
            <AiWorkspacePanel
              ref="wsPanel"
              :workspace="chat.settings.workspace"
              @update:workspace="onWorkspaceChange"
              @presets="onPresets"
            />

            <label class="lbl">LLM 工厂</label>
            <NSelect
              size="small"
              :value="chat.settings.llmFactory"
              :options="factoryOptions"
              clearable
              placeholder="请选择 LLM 工厂"
              :loading="loadingOpts"
              @update:value="onFactoryChange"
            />

            <label class="lbl">API 端点 / 模型</label>
            <NSelect
              size="small"
              :value="chat.settings.provider"
              :options="endpointOptions"
              :disabled="endpointDisabled"
              @update:value="onProviderChange"
            />
            <p class="hint">{{ endpointHint }}</p>

            <label class="lbl">人设</label>
            <NInput
              v-model:value="chat.settings.persona"
              type="textarea"
              :rows="3"
              size="small"
              placeholder="自定义人设…"
              @blur="chat.persistPersona()"
            />

            <label class="lbl">MCP 工具工作流</label>
            <NCheckboxGroup
              v-model:value="chat.settings.workflows"
              @update:value="chat.persistWorkflows()"
            >
              <div class="wf-list">
                <NCheckbox
                  v-for="w in workflowOptions"
                  :key="w.value"
                  :value="w.value"
                  :label="w.label"
                  size="small"
                />
                <p v-if="!workflowOptions.length" class="hint">暂无带 MCP 的工作流</p>
              </div>
            </NCheckboxGroup>

            <NButton size="tiny" secondary @click="openRemoteMcpConfig">远程 MCP 配置</NButton>
            <NButton size="tiny" quaternary @click="loadLlmOptions(true)">刷新模型列表</NButton>
          </div>
        </template>
        <template v-else-if="chat.mode === 'voice'">
          <div class="device-box">
            <NTag size="small" :bordered="true" :type="deviceStatusType">{{ deviceStatusLabel }}</NTag>
            <NButton size="tiny" secondary @click="device.ensure()">重连设备</NButton>
            <label class="lbl">LLM 工厂</label>
            <NSelect
              size="small"
              :value="chat.settings.llmFactory"
              :options="factoryOptions"
              clearable
              :loading="loadingOpts"
              @update:value="onFactoryChange"
            />
            <label class="lbl">端点</label>
            <NSelect
              size="small"
              :value="chat.settings.provider"
              :options="endpointOptions"
              :disabled="endpointDisabled"
              @update:value="onProviderChange"
            />
            <p class="hint side-tip">流式回复 + 设备 TTS/ASR</p>
          </div>
        </template>
        <template v-else>
          <div class="device-box">
            <NTag size="small" :bordered="true" :type="deviceStatusType">{{ deviceStatusLabel }}</NTag>
            <NButton size="tiny" secondary @click="device.ensure()">重连设备</NButton>
            <p class="hint side-tip">设备通道 · 图文 · 引用</p>
          </div>
        </template>
      </NSpace>
      <button
        type="button"
        class="pane-resizer"
        aria-label="调整列表宽度"
        title="拖拽调整宽度"
        @pointerdown="startResize"
      />
    </aside>

    <section class="chat-main brutal-card" :class="{ 'voice-main': chat.mode === 'voice' }">
      <header>
        <div class="title">
          <button
            type="button"
            class="side-toggle"
            :title="sideOpen ? '关闭设置' : '模式 / 设置'"
            :aria-label="sideOpen ? '关闭设置' : '模式 / 设置'"
            @click="sideOpen = !sideOpen"
          >
            <XrkIcon :name="sideOpen ? 'close' : 'menu'" :size="14" />
            <span>{{ sideOpen ? '关闭' : '设置' }}</span>
          </button>
          <span
            class="emo-dot"
            :data-emo="chat.mode === 'voice' ? voiceEmotion : headerEmotion"
            aria-hidden="true"
          >{{ emotionGlyph[chat.mode === 'voice' ? voiceEmotion : headerEmotion] }}</span>
          <strong>{{ headerTitle }}</strong>
          <NTag size="small" :bordered="true" :type="statusType">{{ statusLabel }}</NTag>
        </div>
        <NButton size="small" secondary @click="clearChat">清空</NButton>
      </header>

      <div v-if="chat.mode === 'voice'" class="voice-stage">
        <div class="voice-face" :data-emo="voiceEmotion" aria-hidden="true">
          {{ emotionGlyph[voiceEmotion] }}
        </div>
        <div class="voice-wave" :class="{ active: micActive || streaming }">
          <i v-for="n in 6" :key="n" />
        </div>
        <p class="voice-status">{{ voiceStatus }}</p>
      </div>

      <div
        ref="listEl"
        class="msgs ink-scroll"
        @scroll="onMsgsScroll"
        @load.capture="onMsgsMediaLoad"
      >
        <ChatBubble
          v-for="(m, i) in messages"
          :key="m.id || m.ts || i"
          :message="m"
          :mode="chat.mode"
          :streaming="streaming"
          :is-last-streaming="streaming && i === messages.length - 1 && m.role === 'assistant'"
          @preview="openPreview"
          @copy="copyMsg"
          @delete="deleteMsg"
          @regen="regenerateMsg"
          @quote="quoteMsg"
        />
      </div>

      <div v-if="eventQuote && chat.mode === 'event'" class="quote-strip">
        <span class="quote-lbl">引用</span>
        <span class="quote-text">{{ eventQuote.text.length > 80 ? eventQuote.text.slice(0, 80) + '…' : eventQuote.text }}</span>
        <button type="button" class="quote-x" aria-label="取消引用" @click="clearEventQuote">×</button>
      </div>

      <div v-if="attachments.length && chat.mode !== 'voice'" class="attach-strip">
        <div v-for="a in attachments" :key="a.id" class="attach-item">
          <img v-if="a.isImage" :src="a.previewUrl" alt="" />
          <span v-else class="attach-file">{{ a.name }}</span>
          <button type="button" class="attach-rm" @click="removeAttach(a.id)">×</button>
        </div>
      </div>

      <footer class="composer">
        <button
          type="button"
          class="tool-btn"
          :class="{ on: micActive }"
          :title="chat.mode === 'voice' ? '麦克风（结束即发送）' : '语音填入输入框'"
          :aria-label="chat.mode === 'voice' ? '麦克风' : '语音输入'"
          @click="toggleMic"
        >
          <XrkIcon name="mic" :size="16" />
        </button>
        <template v-if="chat.mode !== 'voice'">
          <input
            ref="fileInputEl"
            type="file"
            class="hidden-file"
            :accept="chat.mode === 'ai' ? 'image/*' : 'image/*,video/*,audio/*'"
            multiple
            @change="onFileInputChange"
          />
          <button
            type="button"
            class="tool-btn"
            :title="chat.mode === 'ai' ? '上传图片' : '上传文件'"
            :aria-label="chat.mode === 'ai' ? '上传图片' : '上传文件'"
            @click="fileInputEl?.click()"
          >
            <XrkIcon :name="chat.mode === 'ai' ? 'image' : 'file'" :size="16" />
          </button>
          <button
            v-if="chat.mode === 'event'"
            type="button"
            class="tool-btn"
            title="戳一戳"
            aria-label="戳一戳"
            @click="sendPoke"
          >
            <XrkIcon name="poke" :size="16" />
          </button>
        </template>
        <NInput
          v-model:value="input"
          :type="chat.mode === 'voice' ? 'text' : 'textarea'"
          :rows="chat.mode === 'voice' ? undefined : 2"
          size="small"
          class="composer-input"
          :placeholder="
            chat.mode === 'voice'
              ? '或直接输入文字…'
              : 'Enter 发送 · Shift+Enter 换行 · 可粘贴/拖拽'
          "
          @keydown.enter.exact.prevent="send"
          @paste="onPaste"
        />
        <div class="composer-actions">
          <NButton
            v-if="chat.mode === 'voice'"
            size="small"
            secondary
            class="act-btn"
            title="停止播报"
            aria-label="停止播报"
            @click="stopVoiceTts"
          >
            <XrkIcon name="stop" :size="14" />
            <span>停止</span>
          </NButton>
          <NButton
            v-else
            size="small"
            tertiary
            class="act-btn"
            :disabled="!canStop"
            title="停止生成"
            aria-label="停止生成"
            @click="stop"
          >
            <XrkIcon name="stop" :size="14" />
            <span>停止</span>
          </NButton>
          <NButton
            size="small"
            type="primary"
            class="act-btn send"
            :loading="busy"
            :disabled="busy"
            aria-label="发送"
            @click="send"
          >
            <XrkIcon v-if="!busy" name="send" :size="14" />
            <span>发送</span>
          </NButton>
        </div>
      </footer>
    </section>

    <div v-if="previewUrl" class="img-preview" @click.self="closePreview">
      <button type="button" class="img-preview-close" @click="closePreview">×</button>
      <button type="button" class="img-preview-save" @click="savePreview">保存</button>
      <img :src="previewUrl" alt="预览" />
    </div>
  </div>
</template>

<style scoped>
.chat-page {
  display: grid;
  grid-template-columns: var(--list-pane-w, 260px) minmax(0, 1fr);
  gap: var(--gap);
  height: 100%;
  min-height: 100%;
  overflow: hidden;
}
.side-toggle,
.side-scrim {
  display: none;
}
.chat-side,
.chat-main {
  padding: 8px;
  min-height: 0;
  overflow: hidden;
}
.chat-side {
  overflow: auto;
  position: relative;
  min-width: 0;
}
.mode-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3px;
}
.mode-btn {
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--card);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 700;
  padding: 5px 2px;
}
.mode-btn.active {
  background: var(--pink);
  box-shadow: var(--shadow);
}
.settings-toggle {
  width: 100%;
  text-align: left;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--paper-2);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 800;
  padding: 4px 6px;
}
.ai-settings {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lbl {
  font-size: var(--font-xs);
  font-weight: 800;
  margin-top: 2px;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--muted);
  line-height: 1.35;
}
.side-tip {
  padding: 2px 0;
}
.device-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 2px;
}
.wf-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 110px;
  overflow: auto;
}
.chat-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  min-width: 0;
  flex: 1;
}
.title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.emo-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--ink);
  border-radius: 50%;
  font-size: var(--font-xs);
  font-weight: 800;
  background: var(--yellow);
  flex-shrink: 0;
}
.emo-dot[data-emo='think'],
.emo-dot[data-emo='listen'] { background: var(--cyan); }
.emo-dot[data-emo='sad'] { background: var(--red); }
.emo-dot[data-emo='message'] { background: var(--pink); }
.quote-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 4px 8px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--pink) 14%, var(--card));
  font-size: var(--font-xs);
}
.quote-lbl { font-weight: 800; flex-shrink: 0; }
.quote-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quote-x {
  border: none;
  background: transparent;
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
}
.msgs {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 14px;
  border: 1.5px dashed color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 8px;
  min-height: 0;
  background: color-mix(in srgb, var(--paper) 40%, var(--card));
}
.img-preview {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: color-mix(in srgb, var(--ink) 72%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.img-preview img {
  max-width: min(96vw, 1100px);
  max-height: 90vh;
  object-fit: contain;
  border: 2px solid var(--ink);
  border-radius: 8px;
  background: var(--card);
}
.img-preview-close {
  position: absolute;
  top: 16px;
  right: 20px;
  width: 36px;
  height: 36px;
  border: 2px solid var(--ink);
  border-radius: 50%;
  background: var(--pink);
  font-size: 22px;
  line-height: 1;
  box-shadow: var(--shadow);
}
.img-preview-save {
  position: absolute;
  top: 16px;
  right: 64px;
  height: 36px;
  padding: 0 12px;
  border: 2px solid var(--ink);
  border-radius: 8px;
  background: var(--yellow);
  font: inherit;
  font-size: 12px;
  font-weight: 800;
  box-shadow: var(--shadow);
  cursor: pointer;
}
.voice-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 6px 4px;
  flex-shrink: 0;
  border: 2px solid var(--ink);
  border-radius: 8px;
  background: color-mix(in srgb, var(--pink) 14%, var(--card));
  box-shadow: var(--shadow);
}
.voice-face {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--ink);
  border-radius: 50%;
  background: var(--yellow);
  font-size: 22px;
  font-weight: 800;
  line-height: 1;
}
.voice-face[data-emo='listen'],
.voice-face[data-emo='think'] { background: var(--cyan); }
.voice-face[data-emo='sad'] { background: var(--red); }
.voice-face[data-emo='message'] { background: var(--pink); }
.voice-wave {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 28px;
}
.voice-wave i {
  display: block;
  width: 5px;
  height: 8px;
  border-radius: 2px;
  border: 1.5px solid var(--ink);
  background: var(--cyan);
}
.voice-wave.active i { animation: wave 0.7s ease-in-out infinite alternate; }
.voice-wave.active i:nth-child(2) { animation-delay: 0.08s; }
.voice-wave.active i:nth-child(3) { animation-delay: 0.16s; }
.voice-wave.active i:nth-child(4) { animation-delay: 0.24s; }
.voice-wave.active i:nth-child(5) { animation-delay: 0.32s; }
.voice-wave.active i:nth-child(6) { animation-delay: 0.4s; }
@keyframes wave {
  from { height: 6px; }
  to { height: 26px; }
}
.voice-status {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
}
.composer {
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  gap: 6px;
  flex-shrink: 0;
  margin-top: auto;
}
.composer-input { flex: 1; min-width: 0; }
.composer-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.voice-main .composer { align-items: center; }
.voice-main .composer-actions { flex-direction: row; }
.hidden-file { display: none; }
.tool-btn {
  width: 36px;
  height: 36px;
  border: 1.5px solid var(--ink);
  border-radius: 8px;
  background: var(--yellow);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ink);
  flex-shrink: 0;
  box-shadow: var(--shadow);
  padding: 0;
}
.tool-btn.on {
  background: var(--pink);
  animation: pulse 1s ease-in-out infinite;
}
.act-btn {
  display: inline-flex !important;
  align-items: center;
  gap: 4px;
  font-weight: 700 !important;
}
.act-btn.send {
  min-width: 72px;
}
@keyframes pulse {
  50% { transform: scale(1.06); }
}
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex-shrink: 0;
  padding: 4px 2px;
}
.attach-item {
  position: relative;
  width: 56px;
  height: 56px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  overflow: hidden;
  background: var(--card);
}
.attach-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.attach-file {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: var(--font-xs);
  padding: 4px;
  text-align: center;
  word-break: break-all;
}
.attach-rm {
  position: absolute;
  top: 0;
  right: 0;
  width: 16px;
  height: 16px;
  border: none;
  background: var(--pink);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.chat-page.is-dragover .chat-main {
  outline: 3px dashed var(--pink);
  outline-offset: -4px;
}
@media (max-width: 900px) {
  .chat-page {
    display: flex;
    flex-direction: column;
    grid-template-columns: none;
    height: 100%;
    min-height: 0;
  }
  .side-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    border: 1.5px solid var(--ink);
    border-radius: 6px;
    background: var(--pink);
    font: inherit;
    width: 32px;
    height: 32px;
    padding: 0;
    box-shadow: var(--shadow);
    flex: 0 0 auto;
    touch-action: manipulation;
  }
  .side-toggle span {
    display: none;
  }
  .side-toggle:active {
    transform: translate(1px, 1px);
    box-shadow: none;
  }
  .side-scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 40;
    background: color-mix(in srgb, #000 45%, transparent);
  }
  .chat-side {
    display: none;
  }
  .chat-page .pane-resizer {
    display: none;
  }
  .chat-page.side-open .chat-side {
    display: flex;
    position: fixed;
    z-index: 50;
    left: max(var(--gap), env(safe-area-inset-left));
    top: calc(var(--topbar-h) + var(--gap) * 2 + 36px);
    bottom: max(var(--gap), env(safe-area-inset-bottom));
    width: min(300px, calc(100vw - var(--gap) * 2));
    max-height: none;
    box-shadow: 4px 4px 0 var(--ink);
    overflow: auto;
  }
  .chat-main {
    flex: 1;
    min-height: 0;
  }
  .chat-main > header {
    gap: 8px;
  }
  .msgs {
    min-height: 200px;
  }
  .chat-page.is-mobile-page.side-open .chat-side {
    top: max(48px, env(safe-area-inset-top) + 44px);
    bottom: calc(var(--shell-tabbar-h, 52px) + env(safe-area-inset-bottom));
  }
  .chat-page.is-mobile-page .composer {
    gap: 4px;
  }
  .chat-page.is-mobile-page .tool-btn {
    width: 34px;
    height: 34px;
  }
  .chat-page.is-mobile-page .composer-input :deep(textarea) {
    font-size: 16px; /* 避免 iOS 聚焦放大 */
  }
}
</style>
