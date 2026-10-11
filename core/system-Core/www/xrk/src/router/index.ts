import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/home' },
  {
    path: '/home',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '系统概览', label: '概览' },
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('@/views/ChatView.vue'),
    meta: { title: 'AI 对话', label: '对话' },
  },
  {
    path: '/config',
    name: 'config',
    component: () => import('@/views/ConfigView.vue'),
    meta: { title: '配置管理', label: '配置' },
  },
  {
    path: '/api',
    name: 'api',
    component: () => import('@/views/ApiDebugView.vue'),
    meta: { title: 'API 调试', label: 'API' },
  },
];

export const router = createRouter({
  // hash：纯静态挂载无需 SPA fallback
  history: createWebHashHistory(),
  routes,
});

router.afterEach((to) => {
  document.title = `${to.meta.title || 'XRK'} · XRK-AGT`;
  try {
    localStorage.setItem('lastPage', String(to.name || 'home'));
  } catch {
    /* ignore */
  }
});
