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
  <div class="m-shell shell-enter">
    <header class="m-topbar surface">
      <div class="m-brand">
        <span class="logo" aria-hidden="true">XRK</span>
        <div class="m-titles">
          <strong class="brand-mark">XRK-AGT</strong>
          <h1>{{ pageTitle }}</h1>
        </div>
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
  padding: 8px 10px;
  min-height: 44px;
  margin-bottom: 6px;
}
.m-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.logo {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: var(--ink);
  color: var(--accent);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 800;
  flex-shrink: 0;
}
.m-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 0;
}
.brand-mark {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.m-topbar h1 {
  margin: 0;
  font-size: 10px;
  font-weight: 500;
  color: var(--muted);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
  overflow: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  position: relative;
}
.m-content > :deep(*) {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
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
  border-top: 1px solid color-mix(in srgb, var(--line) 28%, transparent);
  background: var(--surface);
}
.tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 0;
  background: transparent;
  color: var(--muted);
  border-radius: 4px;
  padding: 6px 2px;
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  touch-action: manipulation;
  min-height: 44px;
  transition: color 160ms var(--ease-out), background 160ms var(--ease-out);
}
.tab-ico {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
}
.tab.active {
  color: var(--ink);
  background: var(--accent-dim);
}
.tab.active .tab-ico {
  color: var(--accent);
}
.tab.active::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 30%;
  right: 30%;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}
.tab-label {
  line-height: 1.1;
}
</style>
