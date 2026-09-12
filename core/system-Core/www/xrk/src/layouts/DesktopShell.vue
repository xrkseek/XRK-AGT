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
  <div class="shell shell-enter" :class="{ collapsed }">
    <aside class="sidebar surface">
      <div class="brand">
        <span class="logo" aria-hidden="true">XRK</span>
        <div v-show="!collapsed" class="brand-text">
          <strong>XRK-AGT</strong>
          <span class="brand-sub">Signal Board</span>
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
      <header class="topbar surface">
        <div class="top-titles">
          <span class="brand-mark">XRK-AGT</span>
          <h1>{{ pageTitle }}</h1>
        </div>
        <NSpace size="small" align="center" :wrap="false" class="toolbar">
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
  padding: 8px;
  overflow: hidden;
}
.shell.collapsed .sidebar {
  flex-basis: 52px;
  width: 52px;
}

.brand {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 22%, transparent);
  margin-bottom: 8px;
}
.logo {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  background: var(--ink);
  color: var(--accent);
  border: 1px solid var(--line);
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.brand-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.brand-text strong {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
}
.brand-sub {
  font-family: var(--mono);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.nav {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-x: hidden;
  overflow-y: auto;
}
.nav-link {
  flex-shrink: 0;
  position: relative;
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--ink);
  text-align: left;
  padding: 8px 8px 8px 10px;
  border-radius: 4px;
  font: inherit;
  font-size: var(--font-ui);
  transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
}
.shell.collapsed .nav-link {
  grid-template-columns: 1fr;
  justify-items: center;
  padding: 10px 4px;
}
.nav-link::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 2px;
  border-radius: 1px;
  background: transparent;
  transition: background 160ms var(--ease-out), top 160ms var(--ease-out), bottom 160ms var(--ease-out);
}
.nav-ico {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: var(--muted);
}
.nav-link.active {
  background: var(--accent-dim);
  font-weight: 700;
}
.nav-link.active::before {
  background: var(--accent);
  top: 12%;
  bottom: 12%;
}
.nav-link.active .nav-ico {
  color: var(--accent);
}
.nav-link:hover:not(.active) {
  background: color-mix(in srgb, var(--line) 6%, transparent);
}
.hint {
  font-size: var(--font-xs);
  opacity: 0.5;
  font-family: var(--mono);
}
.collapse-btn {
  flex-shrink: 0;
  margin-top: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid color-mix(in srgb, var(--line) 28%, transparent);
  background: transparent;
  border-radius: 4px;
  padding: 7px;
  font: inherit;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--muted);
}
.collapse-btn:hover {
  color: var(--ink);
  border-color: var(--accent);
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
  min-height: var(--topbar-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  gap: 10px;
}
.top-titles {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.brand-mark {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--ink);
  flex-shrink: 0;
}
.topbar h1 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toolbar {
  flex-shrink: 0;
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
