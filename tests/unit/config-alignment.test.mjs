import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GLOBAL_CONFIGS,
  SERVER_CONFIGS,
  FACTORY_CONFIG_PATTERNS,
  CHATBOT_FIXED_ROOT_KEYS,
  isFactoryConfig,
  isGlobalConfig,
  isServerConfig,
  isChatbotFixedRootKey,
  isServerOrFactoryConfig,
} from '../../dist/src/infrastructure/config/config-constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfigDir = path.join(root, 'config/default_config');
const commonconfigDir = path.join(root, 'core/system-Core/commonconfig');
/** system.js 门面 + commonconfig/system/*.js 分域 schema */
function collectSystemSchemaSources(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory() && name === 'system') {
      out.push(...collectSystemSchemaSources(full));
      continue;
    }
    if (st.isFile() && /^system(?:-[a-z0-9-]+)?\.(js|ts)$/i.test(name)) {
      out.push(fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
}
const systemSrc = collectSystemSchemaSources(commonconfigDir).join('\n');
const allConfigNames = [...GLOBAL_CONFIGS, ...SERVER_CONFIGS];

describe('配置三件套：默认模板与 system.js schema', () => {
  for (const name of allConfigNames) {
    it(`${name} 模板存在且 schema 含 ${name} 段`, () => {
      const file = path.join(defaultConfigDir, `${name}.yaml`);
      assert.ok(fs.existsSync(file), `缺少默认模板: ${file}`);
      // 兼容：巨石 `name: {`、分域 `name: nameConfig` / `'ai-workflow': aiWorkflowConfig` / `export const aiWorkflowConfig`
      const camel = name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const ok =
        new RegExp(`\\b${name}:\\s*\\{`).test(systemSrc) ||
        new RegExp(`['"]${name}['"]:\\s*${camel}Config\\b`).test(systemSrc) ||
        new RegExp(`\\b${name}:\\s*${name}Config\\b`).test(systemSrc) ||
        new RegExp(`\\b${name}:\\s*${camel}Config\\b`).test(systemSrc) ||
        new RegExp(`export\\s+const\\s+${camel}Config\\b`).test(systemSrc) ||
        new RegExp(`export\\s+const\\s+${name}Config\\b`).test(systemSrc);
      assert.ok(ok, `system 分域 schema 中未找到 ${name} 段`);
    });
  }
});

describe('config-constants type-guard 函数', () => {
  it('isGlobalConfig：全局配置列表内为真，其余为假', () => {
    for (const name of GLOBAL_CONFIGS) assert.equal(isGlobalConfig(name), true);
    assert.equal(isGlobalConfig('server'), false);
    assert.equal(isGlobalConfig('chatbot'), false);
    assert.equal(isGlobalConfig('openai_foo'), false);
  });

  it('isServerConfig：服务器配置列表内为真，全局/工厂/未知为假', () => {
    for (const name of SERVER_CONFIGS) assert.equal(isServerConfig(name), true);
    assert.equal(isServerConfig('agt'), false);
    assert.equal(isServerConfig('deepseek_x'), false);
  });

  it('isFactoryConfig：匹配任一工厂前缀为真，其余为假', () => {
    for (const pattern of FACTORY_CONFIG_PATTERNS) {
      assert.equal(isFactoryConfig(`${pattern}main`), true, `${pattern}main 应命中`);
    }
    // 前缀必须真含于名称（不是字符串任意位置）
    assert.equal(isFactoryConfig('agent'), false);
    assert.equal(isFactoryConfig(''), false);
  });

  it('isChatbotFixedRootKey：固定根级键为真，群号覆盖为假', () => {
    for (const key of CHATBOT_FIXED_ROOT_KEYS) assert.equal(isChatbotFixedRootKey(key), true);
    assert.equal(isChatbotFixedRootKey('123456789'), false, '群号不是固定键');
    assert.equal(isChatbotFixedRootKey('master2'), false);
  });

  it('isServerOrFactoryConfig：服务器或工厂配置为真，全局为假', () => {
    assert.equal(isServerOrFactoryConfig('server'), true);
    assert.equal(isServerOrFactoryConfig('deepseek_main'), true);
    assert.equal(isServerOrFactoryConfig('agt'), false);
    assert.equal(isServerOrFactoryConfig('random'), false);
  });
});
