/** 控制台主导航（桌面侧栏 / 手机底栏共用） */
export const SHELL_NAV = [
  { name: 'home', label: '概览', hint: 'Home', icon: 'home', accent: 'var(--yellow)' },
  { name: 'chat', label: '对话', hint: 'Chat', icon: 'chat', accent: 'var(--pink)' },
  { name: 'config', label: '配置', hint: 'Config', icon: 'config', accent: 'var(--cyan)' },
  { name: 'api', label: 'API', hint: 'Debug', icon: 'api', accent: 'var(--green)' },
];

export const SHELL_KEEPALIVE = ['HomeView', 'ChatView', 'ConfigView', 'ApiDebugView'];
