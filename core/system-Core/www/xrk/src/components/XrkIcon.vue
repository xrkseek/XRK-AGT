<script setup lang="ts">
/**
 * 统一线标：粗描边、圆角端点，不引图标库。
 */
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
});
</script>

<template>
  <svg
    class="xrk-ico"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- 导航 -->
    <template v-if="name === 'home'">
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z" />
    </template>
    <template v-else-if="name === 'chat'">
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
    </template>
    <template v-else-if="name === 'config'">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.9 6.5l1.6 1.6M17.5 15.9l1.6 1.6M3 12h2.2M18.8 12H21M4.9 17.5l1.6-1.6M17.5 8.1l1.6-1.6" />
    </template>
    <template v-else-if="name === 'api'">
      <path d="M8 8H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
      <path d="M16 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3" />
      <path d="M9 12h6M9 16h4" />
    </template>

    <!-- 顶栏 -->
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20 14.5A7.5 7.5 0 1 1 9.5 4 6 6 0 0 0 20 14.5z" />
    </template>
    <template v-else-if="name === 'key'">
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11 12h10v3h-3v2h-3v-2h-1" />
    </template>
    <template v-else-if="name === 'collapse'">
      <path d="M15 6 9 12l6 6" />
    </template>
    <template v-else-if="name === 'expand'">
      <path d="M9 6l6 6-6 6" />
    </template>

    <!-- 聊天工具 -->
    <template v-else-if="name === 'mic'">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m3 16 5-4 4 3 3-2 6 4" />
    </template>
    <template v-else-if="name === 'file'">
      <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </template>
    <template v-else-if="name === 'poke'">
      <path d="M9 11V6.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M15 11V7a1.5 1.5 0 0 1 3 0v7.5a5.5 5.5 0 0 1-5.5 5.5H12a6 6 0 0 1-6-6v-2a1.5 1.5 0 0 1 3 0V11" />
    </template>
    <template v-else-if="name === 'stop'">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="M4 12 20 4l-6 16-2.5-6.5L4 12z" />
    </template>

    <!-- 配置工具 -->
    <template v-else-if="name === 'form'">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </template>
    <template v-else-if="name === 'json'">
      <path d="M8 6c-2 0-3 1.5-3 3.5S6 13 8 13M16 6c2 0 3 1.5 3 3.5S18 13 16 13M8 13c-2 0-3 1.5-3 3.5S6 20 8 20M16 13c2 0 3 1.5 3 3.5S18 20 16 20" />
    </template>
    <template v-else-if="name === 'dense'">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </template>
    <template v-else-if="name === 'comfortable'">
      <path d="M4 6h16M4 12h16M4 18h16" stroke-width="1.5" />
      <path d="M4 9h16M4 15h16" opacity="0.35" />
    </template>
    <template v-else-if="name === 'reload'">
      <path d="M4 12a8 8 0 0 1 13.5-5.8L20 4v6h-6" />
      <path d="M20 12a8 8 0 0 1-13.5 5.8L4 20v-6h6" />
    </template>
    <template v-else-if="name === 'backup'">
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <path d="M12 4v12M8 12l4 4 4-4" />
    </template>
    <template v-else-if="name === 'reset'">
      <path d="M4 8V4h4" />
      <path d="M4 4a9 9 0 1 1-1.5 8.5" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </template>
    <template v-else-if="name === 'up'">
      <path d="m6 14 6-6 6 6" />
    </template>
    <template v-else-if="name === 'down'">
      <path d="m6 10 6 6 6-6" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9 7V5h6v2M8 7l1 13h6l1-13" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M5 12.5 10 17.5 19 7" />
    </template>
    <template v-else-if="name === 'upload'">
      <path d="M12 16V5M8 9l4-4 4 4" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </template>
    <template v-else-if="name === 'menu'">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M6 6l12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M6 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </template>
    <template v-else-if="name === 'quote'">
      <path d="M8 17H5.5A2.5 2.5 0 0 1 3 14.5V13a4 4 0 0 1 4-4h1v8zM19 17h-2.5A2.5 2.5 0 0 1 14 14.5V13a4 4 0 0 1 4-4h1v8z" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="8" />
    </template>
  </svg>
</template>

<style scoped>
.xrk-ico {
  display: block;
  flex-shrink: 0;
}
</style>
