import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateApiInstance } from '../../dist/src/infrastructure/http/utils/helpers.js';
import { listSystemCoreJs } from '../helpers/system-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_HTTP = path.join(root, 'dist', 'core', 'system-Core', 'http');

describe('system-Core HTTP 模块结构', () => {
  for (const file of listSystemCoreJs('http')) {
    const distFile = file.replace(/\.ts$/, '.js');
    it(`${file} 导出有效 HttpApi 结构`, async () => {
      const mod = await import(pathToFileURL(path.join(DIST_HTTP, distFile)).href);
      const api = mod.default;
      assert.ok(validateApiInstance(api, file), file);
      assert.ok(api.routes.length > 0, `${file} 无路由`);
      for (const route of api.routes) {
        assert.ok(route.method && route.path && route.handler, `${file} 路由不完整`);
      }
    });
  }
});
