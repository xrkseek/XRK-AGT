/**
 * LLM 工厂清单的一致性契约。
 *
 * src/factory/llm/LLMFactory.ts 的 factoryRegistry（运行时真源，决定 providers[] 解析）
 * 与 core/system-Core/commonconfig/shared/llm-factory-registry.ts 的 LLM_FACTORY_METAS
 * （侧栏展示镜像）是跨层两处维护，字段交集为 configKey + displayName。
 *
 * 不合并的原因：core 侧的 preset 驱动 schema 生成（buildLlmProvidersFromPreset），
 * 无法从 src 的 protocol/defaultProtocol 派生；把展示元数据塞进运行时注册表是负收益。
 *
 * 本测试锁定「两处清单必须同步」，防止新增/删除工厂时只改了一边：
 * - 名称集合完全一致
 * - 每个名称的 displayName 一致
 * - core 侧的 preset 与 src 侧的 protocol/defaultProtocol 一一对应（防错位）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { factoryRegistry } = await import(
  '../../dist/src/factory/llm/LLMFactory.js'
);
const { LLM_FACTORY_METAS } = await import(
  '../../dist/core/system-Core/commonconfig/shared/llm-factory-registry.js'
);

// 期望的 name → protocol 映射（改 src 注册表的 protocol 必须同步此表）
const EXPECTED_PROTOCOL = {
  volcengine_llm: 'volcengine',
  deepseek_llm: 'deepseek',
  xiaomimimo_llm: 'xiaomimimo',
  openai_llm: 'openai',
  gemini_llm: 'gemini',
  anthropic_llm: 'anthropic',
  azure_openai_llm: 'azure_openai',
  openai_compat_llm: 'openai',
  openai_responses_compat_llm: 'openai-response',
  newapi_compat_llm: 'new-api',
  cherryin_compat_llm: 'cherryin',
  ollama_compat_llm: 'ollama',
  gemini_compat_llm: 'gemini',
  anthropic_compat_llm: 'anthropic',
  azure_openai_compat_llm: 'azure-openai',
};

describe('LLM 工厂清单跨层一致', () => {
  it('两侧名称集合完全一致', () => {
    const srcNames = factoryRegistry.map((e) => e.configKey).sort();
    const coreNames = LLM_FACTORY_METAS.map((m) => m.name).sort();
    assert.deepEqual(srcNames, coreNames, '新增/删除工厂必须两侧同步');
  });

  it('每个名称的 displayName 一致', () => {
    const coreByName = new Map(LLM_FACTORY_METAS.map((m) => [m.name, m.displayName]));
    for (const e of factoryRegistry) {
      assert.equal(
        coreByName.get(e.configKey),
        e.displayName,
        `${e.configKey} 的 displayName 两侧不一致`,
      );
    }
  });

  it('src 侧 protocol 与预期映射一致（core preset 的语义基准）', () => {
    const srcProtocol = new Map(
      factoryRegistry.map((e) => [e.configKey, e.protocol ?? e.defaultProtocol]),
    );
    for (const [name, proto] of Object.entries(EXPECTED_PROTOCOL)) {
      assert.equal(
        srcProtocol.get(name),
        proto,
        `${name} 的 protocol 与预期不符（core 侧 preset 依赖它生成 schema）`,
      );
    }
  });

  it('core 侧每个 meta 都有 description 与 schema（侧栏可渲染）', () => {
    for (const m of LLM_FACTORY_METAS) {
      assert.ok(m.description, `${m.name} 缺 description`);
      assert.ok(m.schema?.fields?.providers, `${m.name} 缺 providers schema`);
      assert.equal(m.fileType, 'yaml');
    }
  });

  it('src 注册表无空 protocol（builtin 与 compat 都有协议）', () => {
    for (const e of factoryRegistry) {
      const proto = e.protocol ?? e.defaultProtocol;
      assert.ok(proto && typeof proto === 'string', `${e.configKey} 缺少 protocol`);
    }
  });
});
