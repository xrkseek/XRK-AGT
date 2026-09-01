<script setup>
import { computed, ref } from 'vue';
import {
  parseToolResultPayload,
  summarizeToolResultText,
  toolArgsText,
  toolName,
  toolResultPreview,
} from '@/chat/tools';

const props = defineProps({
  tools: { type: Array, default: () => [] },
});

/** Explicit toggles only; unset → default open when args/result present. */
const openMap = ref({});

function hasBody(item) {
  const args = String(item.args || '').trim();
  const result = String(item.result || '').trim();
  return (args && args !== '{}') || Boolean(result) || Boolean(item.preview);
}

function isOpen(i, item) {
  if (Object.prototype.hasOwnProperty.call(openMap.value, i)) {
    return Boolean(openMap.value[i]);
  }
  return hasBody(item);
}

function toggle(i) {
  const cur = isOpen(i, items.value[i]);
  openMap.value = { ...openMap.value, [i]: !cur };
}

const items = computed(() =>
  (props.tools || []).map((tool) => {
    const name = toolName(tool);
    const args = toolArgsText(tool);
    const payload = parseToolResultPayload(tool.result ?? tool.content ?? '');
    const preview = toolResultPreview(name, payload ?? tool.result);
    const result = summarizeToolResultText(payload ?? tool.result ?? tool.content ?? '');
    const running = tool.result == null && tool.content == null && !tool.isError;
    return { name, args, preview, result, running, isError: !!tool.isError };
  }),
);
</script>

<template>
  <div class="tool-blocks">
    <div
      v-for="(item, i) in items"
      :key="i"
      class="tool-block"
      :class="{ err: item.isError, run: item.running }"
    >
      <button
        type="button"
        class="tool-head"
        :aria-expanded="isOpen(i, item) ? 'true' : 'false'"
        @click="toggle(i)"
      >
        <span class="tool-ico">{{ item.isError ? '⚠' : item.running ? '…' : '✓' }}</span>
        <span class="tool-title">{{ item.name }}</span>
        <span class="tool-toggle">{{ isOpen(i, item) ? '收起' : '展开' }}</span>
      </button>
      <div v-show="isOpen(i, item)" class="tool-body">
        <div class="tool-sec">
          <span class="lbl">参数</span>
          <pre>{{ item.args }}</pre>
        </div>
        <div v-if="item.preview?.type === 'image'" class="tool-sec">
          <img class="tool-shot" :src="item.preview.src" :alt="item.preview.alt" loading="lazy" />
        </div>
        <div class="tool-sec">
          <span class="lbl">结果</span>
          <pre>{{ item.result || (item.running ? '执行中…' : '') }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-blocks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.tool-block {
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: color-mix(in srgb, var(--cyan) 12%, var(--card));
  overflow: hidden;
}
.tool-block.err {
  background: color-mix(in srgb, var(--danger, #c44) 14%, var(--card));
}
.tool-block.run {
  background: color-mix(in srgb, var(--amber, #c90) 12%, var(--card));
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}
.tool-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-toggle {
  font-size: var(--font-xs);
  opacity: 0.7;
}
.tool-body {
  border-top: 1px dashed color-mix(in srgb, var(--ink) 35%, transparent);
  padding: 6px 8px 8px;
}
.tool-sec {
  margin-bottom: 6px;
}
.tool-sec:last-child {
  margin-bottom: 0;
}
.lbl {
  display: block;
  font-size: var(--font-xs);
  font-weight: 800;
  opacity: 0.55;
  margin-bottom: 2px;
}
pre {
  margin: 0;
  padding: 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: var(--mono);
  font-size: var(--font-xs);
  line-height: 1.35;
  overflow: auto;
  max-height: 220px;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-shot {
  max-width: 100%;
  max-height: 200px;
  border-radius: 4px;
  border: 1px solid var(--ink);
}
</style>
