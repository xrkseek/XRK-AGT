<script setup>
import { computed, ref } from 'vue';
import { useRoute, useRouter, RouterView } from 'vue-router';
import { NButton, NInput, NSpace, NTag, NTooltip } from 'naive-ui';
import XrkIcon from '@/components/XrkIcon.vue';
import { SHELL_NAV, SHELL_KEEPALIVE } from '@/layouts/shell-nav.js';
import { useShellAuth } from '@/composables/useShellAuth.js';

const route = useRoute();
const router = useRouter();
const { auth, keyDraft, saveKey, onKeyEnter } = useShellAuth();
const collapsed = ref(localStorage.getItem('xrk.sidebarCollapsed') === '1');
const nav = SHELL_NAV;
const pageTitle = computed(() => route.meta.title || 'XRK');

function go(name) {
  router.push({ name });
}

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  try {
    localStorage.setItem('xrk.sidebarCollapsed', collapsed.value ? '1' : '0');
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <a href="#main" class="skip-link">跳到主内容</a>
  <div class="shell" :class="{ collapsed }">
    <aside class="sidebar brutal-card">
      <div class="brand">
        <span class="logo" aria-hidden="true">★</span>
        <div v-show="!collapsed" class="brand-text">
          <strong>XRK-AGT</strong>
        </div>
      </div>
      <nav class="nav ink-scroll" aria-label="主菜单">
        <button
          v-for="item in nav"
          :key="item.name"
          type="button"
          class="nav-link"
          :class="{ active: route.name === item.name }"
          :style="{ '--accent': item.accent }"
          :title="collapsed ? item.label : undefined"
          :aria-label="item.label"
          @click="go(item.name)"
        >
          <span class="nav-ico" aria-hidden="true">
            <XrkIcon :name="item.icon" :size="13" />
          </span>
          <span v-show="!collapsed" class="label">{{ item.label }}</span>
          <span v-show="!collapsed" class="hint">{{ item.hint }}</span>
        </button>
      </nav>
      <button type="button" class="collapse-btn" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" @click="toggleCollapse">
        <XrkIcon :name="collapsed ? 'expand' : 'collapse'" :size="14" />
        <span v-show="!collapsed">收起</span>
      </button>
    </aside>

    <div class="main-col">
      <header class="topbar brutal-card">
        <h1>{{ pageTitle }}</h1>
        <NSpace size="small" align="center" :wrap="false">
          <NInput
            v-model:value="keyDraft"
            size="small"
            type="password"
            show-password-on="click"
            placeholder="X-API-Key"
            style="width: 148px"
            title="填写后点保存或回车；清空后回车可清除"
            @keyup.enter="onKeyEnter"
          />
          <NButton size="small" type="primary" secondary @click="saveKey">保存</NButton>
          <NTooltip>
            <template #trigger>
              <NButton size="small" secondary class="icon-btn" :aria-label="auth.dark ? '切换浅色' : '切换深色'" @click="auth.toggleDark()">
                <XrkIcon :name="auth.dark ? 'sun' : 'moon'" :size="15" />
              </NButton>
            </template>
            {{ auth.dark ? '切换浅色' : '切换深色' }}
          </NTooltip>
          <NTag size="small" :type="auth.authBadge.type" :bordered="true" :title="auth.authBadge.title">
            <span class="key-tag">
              <XrkIcon name="key" :size="12" />
              {{ auth.authBadge.text }}
            </span>
          </NTag>
        </NSpace>
      </header>

      <main id="main" class="content ink-scroll">
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="SHELL_KEEPALIVE" :max="4">
            <component :is="Component" />
          </KeepAlive>
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  position: fixed;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: stretch;
  gap: var(--gap);
  padding: var(--gap);
  box-sizing: border-box;
  overflow: hidden;
}

.sidebar {
  flex: 0 0 var(--sidebar-w);
  width: var(--sidebar-w);
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  padding: 6px;
  overflow: hidden;
}
.shell.collapsed .sidebar {
  flex-basis: 48px;
  width: 48px;
}

.brand {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px 8px;
  border-bottom: 2px solid var(--ink);
  margin-bottom: 6px;
}
.logo {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: var(--yellow);
  border: 2px solid var(--ink);
  border-radius: 6px;
  font-size: 12px;
  box-shadow: var(--shadow);
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.brand-text strong {
  font-size: 13px;
  letter-spacing: 0.02em;
  line-height: 1.2;
}

.nav {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-x: hidden;
  overflow-y: auto;
}
.nav-link {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 6px;
  border: 1.5px solid transparent;
  background: transparent;
  color: var(--ink);
  text-align: left;
  padding: 7px 6px;
  border-radius: 6px;
  font: inherit;
  font-size: var(--font-ui);
}
.shell.collapsed .nav-link {
  grid-template-columns: 1fr;
  justify-items: center;
  padding: 8px 4px;
}
.nav-ico {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  background: var(--card);
  color: var(--ink);
}
.nav-link.active {
  background: color-mix(in srgb, var(--accent) 55%, var(--card));
  border-color: var(--ink);
  box-shadow: var(--shadow);
  font-weight: 700;
}
.nav-link.active .nav-ico {
  background: var(--accent);
}
.nav-link:hover:not(.active) {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
}
.hint {
  font-size: var(--font-xs);
  opacity: 0.55;
  font-family: var(--mono);
}
.collapse-btn {
  flex-shrink: 0;
  margin-top: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1.5px solid var(--ink);
  background: var(--paper-2);
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: var(--font-sm);
  font-weight: 700;
  box-shadow: var(--shadow);
}
.key-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.icon-btn {
  min-width: 32px;
  padding: 0 8px;
}

.main-col {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  overflow: hidden;
}
.topbar {
  flex-shrink: 0;
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  gap: 8px;
}
.topbar h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.01em;
}
.content {
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  position: relative;
}
.content > :deep(*) {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
</style>
