<script setup>
import { computed } from 'vue';
import { useRoute, useRouter, RouterView } from 'vue-router';
import { NButton, NInput, NSpace, NTag, NTooltip } from 'naive-ui';
import XrkIcon from '@/components/XrkIcon.vue';
import { SHELL_NAV, SHELL_KEEPALIVE } from '@/layouts/shell-nav.js';
import { useShellAuth } from '@/composables/useShellAuth.js';

const route = useRoute();
const router = useRouter();
const { auth, keyDraft, saveKey, onKeyEnter } = useShellAuth();
const nav = SHELL_NAV;
const pageTitle = computed(() => route.meta.title || 'XRK');

function go(name) {
  router.push({ name });
}
</script>

<template>
  <a href="#main" class="skip-link">跳到主内容</a>
  <div class="m-shell">
    <header class="m-topbar brutal-card">
      <div class="m-brand">
        <span class="logo" aria-hidden="true">★</span>
        <h1>{{ pageTitle }}</h1>
      </div>
      <NSpace size="small" align="center" :wrap="false">
        <NInput
          v-model:value="keyDraft"
          size="small"
          type="password"
          show-password-on="click"
          placeholder="Key"
          class="m-key"
          @keyup.enter="onKeyEnter"
        />
        <NButton size="tiny" type="primary" secondary @click="saveKey">保存</NButton>
        <NTooltip>
          <template #trigger>
            <NButton size="small" secondary class="icon-btn" :aria-label="auth.dark ? '切换浅色' : '切换深色'" @click="auth.toggleDark()">
              <XrkIcon :name="auth.dark ? 'sun' : 'moon'" :size="15" />
            </NButton>
          </template>
          {{ auth.dark ? '切换浅色' : '切换深色' }}
        </NTooltip>
        <NTag size="tiny" :type="auth.authBadge.type" :bordered="true" :title="auth.authBadge.title">
          {{ auth.authBadge.text }}
        </NTag>
      </NSpace>
    </header>

    <main id="main" class="m-content ink-scroll">
      <RouterView v-slot="{ Component }">
        <KeepAlive :include="SHELL_KEEPALIVE" :max="4">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </main>

    <nav class="m-tabbar" aria-label="主导航">
      <button
        v-for="item in nav"
        :key="item.name"
        type="button"
        class="tab"
        :class="{ active: route.name === item.name }"
        :style="{ '--accent': item.accent }"
        :aria-label="item.label"
        :aria-current="route.name === item.name ? 'page' : undefined"
        @click="go(item.name)"
      >
        <span class="tab-ico" aria-hidden="true">
          <XrkIcon :name="item.icon" :size="16" />
        </span>
        <span class="tab-label">{{ item.label }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.m-shell {
  --shell-tabbar-h: 52px;
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  padding:
    max(6px, env(safe-area-inset-top))
    max(6px, env(safe-area-inset-right))
    0
    max(6px, env(safe-area-inset-left));
  box-sizing: border-box;
  overflow: hidden;
  background: transparent;
}

.m-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 6px 8px;
  min-height: 40px;
  margin-bottom: 6px;
}
.m-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.logo {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: var(--yellow);
  border: 2px solid var(--ink);
  border-radius: 6px;
  font-size: 11px;
  box-shadow: var(--shadow);
  flex-shrink: 0;
}
.m-topbar h1 {
  margin: 0;
  font-size: 13px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-key {
  width: 88px !important;
}
.icon-btn {
  min-width: 32px;
  padding: 0 8px;
}

.m-content {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: block;
  position: relative;
}
.m-content > :deep(*) {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
}
.m-content > :deep(.chat-page),
.m-content > :deep(.config),
.m-content > :deep(.api) {
  height: 100%;
  max-height: 100%;
  min-height: 0;
}

.m-tabbar {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  margin:
    0
    calc(-1 * max(6px, env(safe-area-inset-right)))
    0
    calc(-1 * max(6px, env(safe-area-inset-left)));
  padding: 4px 6px max(4px, env(safe-area-inset-bottom));
  border-top: 2px solid var(--ink);
  background: var(--card);
  box-shadow: 0 -2px 0 color-mix(in srgb, var(--ink) 8%, transparent);
}
.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: 1.5px solid transparent;
  background: transparent;
  color: var(--ink);
  border-radius: 8px;
  padding: 4px 2px;
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  touch-action: manipulation;
  min-height: 44px;
}
.tab-ico {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--ink);
  border-radius: 8px;
  background: var(--card);
}
.tab.active {
  background: color-mix(in srgb, var(--accent) 45%, var(--card));
  border-color: var(--ink);
  box-shadow: var(--shadow);
}
.tab.active .tab-ico {
  background: var(--accent);
}
.tab-label {
  line-height: 1.1;
}
</style>
