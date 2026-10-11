/**
 * www 源码别名加载器：把 `@/` 前缀映射到 `core/system-Core/www/xrk/src`，
 * 使 Node 测试可直接 import www 下的 Vue/工具源码（原测试只能退化为文本匹配）。
 *
 * 用法：测试文件顶层调用 installXrkAliasHook() 一次，之后任何 `import ... from '@/...'`
 * 都会解析到 `core/system-Core/www/xrk/src/<path>.js`。
 *
 * 背景：`@/utils/http` 这类 specifier 是 Vite 打包器别名，Node 原生无法解析。
 * 这里用 node:module 的 registerHooks（Node ≥ 22.14）做同步 resolve 重映射，
 * 零新增依赖、不改产品代码。
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wwwSrcDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', // helpers -> tests
  '..', // tests -> 仓库根
  'core/system-Core/www/xrk/src',
);

let installed = false;

/** @returns {string} www 源码根（core/system-Core/www/xrk/src） */
export function getXrkWwwSrcDir() {
  return wwwSrcDir;
}

/** 注册 `@/` → www 源码的 resolve hook（幂等） */
export function installXrkAliasHook() {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@/')) {
        let target = path.join(wwwSrcDir, specifier.slice(2));
        if (!path.extname(target)) target += '.js';
        return nextResolve(pathToFileURL(target).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
