/// <reference types="vite/client" />

/** 控制台自定义元素（naive-ui / 自绘 web component）在 TS 下的兜底声明。 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare const __VUE_OPTIONS_API__: boolean;
declare const __VUE_PROD_DEVTOOLS__: boolean;
