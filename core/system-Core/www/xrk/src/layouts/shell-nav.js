/** 控制台主导航（桌面侧栏 / 手机底栏共用）— 对话优先 */
export const SHELL_NAV = [
  { name: 'chat', label: '对话', hint: 'Chat', icon: 'chat', accent: 'var(--accent)' },
  { name: 'home', label: '概览', hint: 'Status', icon: 'home', accent: 'var(--cyan)' },
  { name: 'config', label: '配置', hint: 'Config', icon: 'config', accent: 'var(--yellow)' },
  { name: 'api', label: 'API', hint: 'Debug', icon: 'api', accent: 'var(--green)' },
];

export const SHELL_KEEPALIVE = ['ChatView', 'HomeView', 'ConfigView', 'ApiDebugView'];
