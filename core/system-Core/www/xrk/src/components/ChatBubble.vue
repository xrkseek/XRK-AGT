<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import ChatToolBlock from '@/components/ChatToolBlock.vue';
import XrkIcon from '@/components/XrkIcon.vue';
import { renderMarkdown, renderMermaidIn } from '@/chat/markdown';
import { resolveMediaUrl, segmentsToPlainText } from '@/chat/segments';

const props = defineProps({
  message: { type: Object, required: true },
  mode: { type: String, default: 'ai' },
  streaming: { type: Boolean, default: false },
  isLastStreaming: { type: Boolean, default: false },
});

const emit = defineEmits(['preview', 'copy', 'quote', 'regen', 'delete']);
const rootEl = ref(null);

const ROLE_LABEL = {
  user: '用户',
  assistant: '助手',
  system: '系统',
};

const ROLE_GLYPH = {
  user: '用',
  assistant: '助',
  system: '系',
};

const roleLabel = computed(() => ROLE_LABEL[props.message.role] || props.message.role);
const roleGlyph = computed(() => ROLE_GLYPH[props.message.role] || '·');


const segments = computed(() => {
  const m = props.message;
  if (Array.isArray(m.segments) && m.segments.length) {
    // 兼容历史：mcpTools 挂在消息上但未进 segments
    if (m.mcpTools?.length && !m.segments.some((s) => s?.type === 'tools')) {
      return [...m.segments, { type: 'tools', tools: m.mcpTools }];
    }
    return m.segments;
  }
  if (m.type === 'record' || m.type === 'chat-record') {
    return [];
  }
  const text = m.text || m.content;
  if (text) return [{ type: 'text', text }];
  if (m.mcpTools?.length) return [{ type: 'tools', tools: m.mcpTools }];
  return [];
});

const isRecord = computed(
  () => props.message.type === 'record' || props.message.type === 'chat-record',
);

const plain = computed(() => {
  if (isRecord.value) {
    return [props.message.title, props.message.description].filter(Boolean).join(' · ');
  }
  return props.message.text || props.message.content || segmentsToPlainText(segments.value) || '';
});

function md(text) {
  return renderMarkdown(text);
}

async function paintMermaid() {
  await nextTick();
  if (rootEl.value) await renderMermaidIn(rootEl.value);
}

onMounted(paintMermaid);
watch(segments, paintMermaid, { deep: true });

function onImgLoad(e) {
  e.target?.classList?.add('loaded');
}
function onImgError(e) {
  const img = e?.target;
  if (!img) return;
  img.classList.add('loaded');
  img.alt = '图片加载失败';
}
</script>

<template>
  <div
    ref="rootEl"
    class="msg"
    :data-role="message.role"
    :class="{ streaming: isLastStreaming && streaming }"
  >
    <span class="avatar" :title="roleLabel" :aria-label="roleLabel">{{ roleGlyph }}</span>
    <div class="bubble-wrap">
      <!-- 转发/记录卡片 -->
      <div v-if="isRecord" class="bubble record-card">
        <div v-if="message.title || message.description" class="record-hdr">
          <strong v-if="message.title">{{ message.title }}</strong>
          <p v-if="message.description">{{ message.description }}</p>
        </div>
        <div
          v-for="(line, i) in message.messages || []"
          :key="i"
          class="record-line"
          v-html="md(typeof line === 'string' ? line : line?.text || line?.content || '')"
        />
      </div>

      <div v-else class="bubble">
        <template v-for="(seg, si) in segments" :key="si">
          <div
            v-if="seg.type === 'text' || seg.type === 'markdown' || seg.type === 'raw'"
            class="seg-text"
            v-html="md(seg.text)"
          />
          <div v-else-if="seg.type === 'reply'" class="seg-reply">
            <span class="reply-label">引用</span>
            <span>{{ seg.text || seg.id || '' }}</span>
          </div>
          <div v-else-if="seg.type === 'at'" class="seg-at">@{{ seg.name || seg.qq || '' }}</div>
          <div v-else-if="seg.type === 'poke'" class="seg-poke">戳 · {{ seg.text || '戳一戳' }}</div>
          <div v-else-if="seg.type === 'image'" class="chat-image-container">
            <img
              class="chat-image"
              :src="resolveMediaUrl(seg.url)"
              :alt="seg.name || '图片'"
              loading="lazy"
              title="点击查看大图"
              @click="emit('preview', seg.url)"
              @load="onImgLoad"
              @error="onImgError"
            />
          </div>
          <div v-else-if="seg.type === 'video'" class="chat-media">
            <video :src="resolveMediaUrl(seg.url)" controls preload="metadata" class="chat-video" />
          </div>
          <div v-else-if="seg.type === 'record'" class="chat-media">
            <audio :src="resolveMediaUrl(seg.url)" controls preload="metadata" class="chat-audio" />
          </div>
          <div v-else-if="seg.type === 'file'" class="seg-file">
            <a
              v-if="seg.url"
              :href="resolveMediaUrl(seg.url)"
              :download="seg.name || true"
              target="_blank"
              rel="noopener"
            >
              📄 {{ seg.name || '文件' }}
            </a>
            <span v-else>📄 {{ seg.name || '文件' }}</span>
          </div>
          <div v-else-if="seg.type === 'forward'" class="seg-forward">
            <div class="fwd-title">合并转发{{ seg.id ? ` · ${seg.id}` : '' }}</div>
            <template v-if="seg.segments?.length">
              <div v-for="(fs, fi) in seg.segments" :key="fi" class="fwd-seg">
                <img
                  v-if="fs.type === 'image'"
                  class="chat-image sm"
                  :src="resolveMediaUrl(fs.url)"
                  alt=""
                  @click="emit('preview', fs.url)"
                />
                <video
                  v-else-if="fs.type === 'video'"
                  :src="resolveMediaUrl(fs.url)"
                  controls
                  preload="metadata"
                  class="chat-video sm"
                />
                <audio
                  v-else-if="fs.type === 'record'"
                  :src="resolveMediaUrl(fs.url)"
                  controls
                  class="chat-audio"
                />
                <a
                  v-else-if="fs.type === 'file' && fs.url"
                  :href="resolveMediaUrl(fs.url)"
                  target="_blank"
                  rel="noopener"
                >📄 {{ fs.name || '文件' }}</a>
                <div
                  v-else-if="fs.type === 'text' || fs.type === 'markdown'"
                  class="seg-text"
                  v-html="md(fs.text)"
                />
                <span v-else class="fwd-fallback">{{ fs.text || `[${fs.type}]` }}</span>
              </div>
            </template>
            <div v-else class="fwd-fallback">{{ seg.text || '[转发]' }}</div>
          </div>
          <ChatToolBlock v-else-if="seg.type === 'tools'" :tools="seg.tools || []" />
        </template>
      </div>

      <div v-if="message.role !== 'system'" class="msg-actions">
        <button type="button" class="act" aria-label="复制" title="复制" @click="emit('copy', message)">
          <XrkIcon name="copy" :size="12" />
          <span class="act-label">复制</span>
        </button>
        <button
          v-if="segments.some((s) => s.type === 'image')"
          type="button"
          class="act"
          aria-label="看图"
          title="看图"
          @click="emit('preview', segments.find((s) => s.type === 'image').url)"
        >
          <XrkIcon name="image" :size="12" />
          <span class="act-label">看图</span>
        </button>
        <button
          v-if="mode === 'event' && plain"
          type="button"
          class="act"
          aria-label="引用"
          title="引用"
          @click="emit('quote', message)"
        >
          <XrkIcon name="quote" :size="12" />
          <span class="act-label">引用</span>
        </button>
        <button
          v-if="message.role === 'assistant' && mode === 'ai'"
          type="button"
          class="act"
          aria-label="重生成"
          title="重生成"
          :disabled="streaming"
          @click="emit('regen', message)"
        >
          <XrkIcon name="reload" :size="12" />
          <span class="act-label">重生成</span>
        </button>
        <button type="button" class="act danger" :aria-label="message.role === 'user' ? '撤回' : '删除'" :title="message.role === 'user' ? '撤回' : '删除'" @click="emit('delete', message)">
          <XrkIcon name="trash" :size="12" />
          <span class="act-label">{{ message.role === 'user' ? '撤回' : '删除' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  animation: msgIn 0.28s ease-out;
}
.msg[data-role='user'] {
  flex-direction: row-reverse;
}
@keyframes msgIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.msg.streaming .bubble::after {
  content: '';
  display: inline-block;
  width: 6px;
  height: 1em;
  margin-left: 2px;
  background: var(--ink);
  animation: blink 0.9s step-end infinite;
  vertical-align: text-bottom;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.avatar {
  width: 34px;
  height: 34px;
  border: 1.5px solid var(--ink);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-xs);
  font-weight: 800;
  flex-shrink: 0;
  background: var(--card);
  box-shadow: var(--shadow);
  line-height: 1;
  margin-top: 4px;
}
.msg[data-role='user'] .avatar {
  background: var(--cyan);
}
.msg[data-role='assistant'] .avatar {
  background: var(--yellow);
}
.msg[data-role='system'] .avatar {
  background: color-mix(in srgb, var(--pink) 55%, var(--card));
  box-shadow: none;
  opacity: 0.85;
}
.bubble-wrap {
  min-width: 0;
  max-width: min(100%, 78%);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
@media (max-width: 900px) {
  .bubble-wrap {
    max-width: 94%;
  }
}
.msg[data-role='user'] .bubble-wrap {
  align-items: flex-end;
}
.msg[data-role='system'] .bubble-wrap {
  max-width: 90%;
}
.bubble {
  border: 1.5px solid var(--ink);
  border-radius: 12px;
  padding: 10px 14px;
  background: var(--card);
  box-shadow: var(--shadow);
  font-size: 13.5px;
  line-height: 1.6;
  letter-spacing: 0.01em;
  overflow-wrap: anywhere;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
}
.msg[data-role='user'] .bubble {
  background: color-mix(in srgb, var(--cyan) 22%, var(--card));
  border-radius: 12px 4px 12px 12px;
}
.msg[data-role='assistant'] .bubble {
  background: color-mix(in srgb, var(--yellow) 18%, var(--card));
  border-radius: 4px 12px 12px 12px;
  /* 长文 / 表格需要占满侧栏宽，避免挤成细条 */
  width: 100%;
}
.msg[data-role='system'] .bubble {
  background: color-mix(in srgb, var(--pink) 14%, var(--card));
  box-shadow: none;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
  padding: 8px 12px;
}
.record-card {
  background: color-mix(in srgb, var(--yellow) 14%, var(--card));
  width: 100%;
}
.record-hdr {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed color-mix(in srgb, var(--ink) 28%, transparent);
}
.record-hdr p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.45;
  opacity: 0.72;
}
.record-line {
  margin: 6px 0;
  font-size: 13px;
  line-height: 1.5;
}
.msg-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  opacity: 0.72;
  justify-content: flex-start;
}
.msg[data-role='user'] .msg-actions {
  justify-content: flex-end;
}
.msg:hover .msg-actions,
.msg:focus-within .msg-actions {
  opacity: 1;
}
@media (hover: none) {
  .msg-actions {
    opacity: 1;
  }
  .act {
    padding: 6px;
    min-width: 32px;
    min-height: 32px;
    justify-content: center;
  }
  .act-label {
    display: none;
  }
}
.act {
  border: 1.5px solid color-mix(in srgb, var(--ink) 36%, transparent);
  border-radius: 6px;
  background: var(--card);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 700;
  padding: 4px 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ink);
  line-height: 1.2;
  min-height: 28px;
  touch-action: manipulation;
}
.act:hover {
  background: color-mix(in srgb, var(--yellow) 28%, var(--card));
  border-color: var(--ink);
}
.act:active {
  transform: translate(1px, 1px);
}
.act:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.act.danger {
  color: #b00020;
}
.seg-text {
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.seg-text + .seg-text,
.seg-text + .chat-image-container,
.chat-image-container + .seg-text {
  margin-top: 10px;
}
.seg-reply {
  border-left: 3px solid var(--pink);
  padding: 6px 10px;
  margin: 6px 0;
  background: color-mix(in srgb, var(--pink) 12%, var(--card));
  font-size: var(--font-sm);
  line-height: 1.45;
  border-radius: 0 8px 8px 0;
}
.reply-label {
  font-weight: 800;
  font-size: var(--font-xs);
  margin-right: 6px;
  opacity: 0.6;
}
.seg-at {
  display: inline-block;
  background: color-mix(in srgb, var(--cyan) 35%, var(--card));
  border: 1px solid var(--ink);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: var(--font-xs);
  font-weight: 700;
}
.seg-poke {
  font-size: var(--font-sm);
  font-weight: 700;
}
.seg-file a {
  color: inherit;
  font-weight: 700;
  font-size: var(--font-sm);
}
.seg-forward {
  border: 1.5px solid var(--ink);
  border-radius: 10px;
  padding: 10px;
  background: color-mix(in srgb, var(--cyan) 10%, var(--card));
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.fwd-title {
  font-size: var(--font-xs);
  font-weight: 800;
  opacity: 0.75;
}
.fwd-seg {
  font-size: var(--font-sm);
  line-height: 1.5;
}
.fwd-fallback {
  opacity: 0.8;
  font-size: var(--font-sm);
}
.chat-image.sm,
.chat-video.sm {
  max-width: 160px;
  max-height: 120px;
}
.chat-image-container {
  margin-top: 6px;
}
.chat-image {
  display: block;
  max-width: min(100%, 420px);
  max-height: 360px;
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: 8px;
  border: 1.5px solid var(--ink);
  cursor: zoom-in;
  opacity: 0.35;
  transition: opacity 0.2s ease;
}
.chat-image.loaded {
  opacity: 1;
}
.chat-media {
  margin-top: 6px;
}
.chat-video,
.chat-audio {
  max-width: 100%;
  display: block;
}

/* —— Markdown 正文 —— */
.bubble :deep(p) {
  margin: 0 0 0.65em;
}
.bubble :deep(p:last-child) {
  margin-bottom: 0;
}
.bubble :deep(h1),
.bubble :deep(h2),
.bubble :deep(h3),
.bubble :deep(h4) {
  margin: 0.9em 0 0.4em;
  line-height: 1.35;
  font-weight: 800;
  letter-spacing: 0;
}
.bubble :deep(h1:first-child),
.bubble :deep(h2:first-child),
.bubble :deep(h3:first-child),
.bubble :deep(h4:first-child) {
  margin-top: 0;
}
.bubble :deep(h1) {
  font-size: 1.2em;
}
.bubble :deep(h2) {
  font-size: 1.1em;
}
.bubble :deep(h3),
.bubble :deep(h4) {
  font-size: 1.02em;
}
.bubble :deep(ul),
.bubble :deep(ol) {
  margin: 0.45em 0 0.7em;
  padding-left: 1.35em;
}
.bubble :deep(li) {
  margin: 0.28em 0;
  padding-left: 0.15em;
}
.bubble :deep(li > ul),
.bubble :deep(li > ol) {
  margin: 0.2em 0 0.35em;
}
.bubble :deep(blockquote) {
  margin: 0.65em 0;
  padding: 6px 12px;
  border-left: 3px solid color-mix(in srgb, var(--ink) 45%, transparent);
  background: color-mix(in srgb, var(--paper) 55%, transparent);
  border-radius: 0 8px 8px 0;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
}
.bubble :deep(blockquote p) {
  margin: 0.25em 0;
}
.bubble :deep(hr) {
  border: none;
  border-top: 1.5px dashed color-mix(in srgb, var(--ink) 28%, transparent);
  margin: 0.9em 0;
}
.bubble :deep(a) {
  color: color-mix(in srgb, var(--ink) 70%, #0a6);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bubble :deep(strong) {
  font-weight: 800;
}
.bubble :deep(em) {
  font-style: italic;
}

/* —— 表格 —— */
.bubble :deep(table) {
  border-collapse: separate;
  border-spacing: 0;
  margin: 0.75em 0;
  font-size: 12.5px;
  line-height: 1.45;
  width: max-content;
  min-width: 100%;
  border: 1.5px solid color-mix(in srgb, var(--ink) 32%, transparent);
  border-radius: 8px;
  overflow: hidden;
  background: var(--card);
}
.bubble :deep(thead th) {
  background: color-mix(in srgb, var(--ink) 9%, var(--card));
  font-weight: 800;
  white-space: nowrap;
}
.bubble :deep(th),
.bubble :deep(td) {
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-right: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
}
.bubble :deep(th:last-child),
.bubble :deep(td:last-child) {
  border-right: none;
}
.bubble :deep(tbody tr:last-child th),
.bubble :deep(tbody tr:last-child td) {
  border-bottom: none;
}
.bubble :deep(tbody tr:nth-child(even) td) {
  background: color-mix(in srgb, var(--paper) 45%, transparent);
}
.bubble :deep(tbody tr:hover td) {
  background: color-mix(in srgb, var(--yellow) 14%, var(--card));
}

/* —— 代码 —— */
.bubble :deep(pre) {
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  margin: 0.65em 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  background: color-mix(in srgb, var(--ink) 5%, var(--paper));
  max-width: 100%;
}
.bubble :deep(pre code) {
  font-size: inherit;
  padding: 0;
  background: none;
  border: none;
  border-radius: 0;
}
.bubble :deep(:not(pre) > code) {
  font-family: var(--mono);
  font-size: 0.9em;
  padding: 0.12em 0.4em;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
}
.bubble :deep(code) {
  font-family: var(--mono);
}

.bubble :deep(.chat-mermaid) {
  margin: 0.65em 0;
  overflow: auto;
  border: 1.5px solid color-mix(in srgb, var(--ink) 28%, transparent);
  border-radius: 8px;
  background: var(--card);
}
.bubble :deep(.chat-mermaid-bar) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1.5px solid color-mix(in srgb, var(--ink) 18%, transparent);
  background: color-mix(in srgb, var(--paper) 55%, var(--card));
}
.bubble :deep(.mmd-act) {
  margin: 0;
  border: 1.5px solid color-mix(in srgb, var(--ink) 40%, transparent);
  border-radius: 5px;
  background: var(--card);
  color: var(--ink);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 700;
  padding: 3px 8px;
  cursor: pointer;
  line-height: 1.2;
  min-height: 26px;
  touch-action: manipulation;
}
.bubble :deep(.mmd-act:hover) {
  background: color-mix(in srgb, var(--cyan) 22%, var(--card));
  border-color: var(--ink);
}
.bubble :deep(.mmd-act:active) {
  transform: translate(1px, 1px);
}
.bubble :deep(.mmd-act:disabled) {
  opacity: 0.85;
  cursor: default;
}
.bubble :deep(.chat-mermaid-canvas) {
  padding: 10px;
  overflow: auto;
  max-width: 100%;
}
.bubble :deep(.chat-mermaid-canvas svg) {
  max-width: 100%;
  height: auto;
  display: block;
}
.bubble :deep(.chat-mermaid-error) {
  color: #b00020;
  font-size: var(--font-xs);
}
</style>
