import { defineLlmFactoryMeta } from './llm-factory-meta.js';

/** 官方 + 兼容工厂清单（侧栏「AI LLM 工厂」子配置） */
export const LLM_FACTORY_METAS = [
  defineLlmFactoryMeta({
    name: 'volcengine_llm',
    displayName: '火山引擎（官方）',
    description: '方舟 Responses / 豆包；providers[] 多端点',
    preset: 'volcengine',
  }),
  defineLlmFactoryMeta({
    name: 'deepseek_llm',
    displayName: 'DeepSeek（官方）',
    preset: 'deepseek',
  }),
  defineLlmFactoryMeta({
    name: 'xiaomimimo_llm',
    displayName: '小米 MiMo（官方）',
    preset: 'xiaomimimo',
  }),
  defineLlmFactoryMeta({
    name: 'openai_llm',
    displayName: 'OpenAI（官方）',
    preset: 'openai',
  }),
  defineLlmFactoryMeta({
    name: 'gemini_llm',
    displayName: 'Gemini（官方）',
    preset: 'gemini',
  }),
  defineLlmFactoryMeta({
    name: 'anthropic_llm',
    displayName: 'Anthropic（官方）',
    preset: 'anthropic',
  }),
  defineLlmFactoryMeta({
    name: 'azure_openai_llm',
    displayName: 'Azure OpenAI（官方）',
    preset: 'azure_openai',
  }),
  defineLlmFactoryMeta({
    name: 'openai_compat_llm',
    displayName: 'OpenAI Chat 兼容',
    preset: 'openai_compat',
  }),
  defineLlmFactoryMeta({
    name: 'openai_responses_compat_llm',
    displayName: 'OpenAI Responses 兼容',
    preset: 'openai_responses_compat',
  }),
  defineLlmFactoryMeta({
    name: 'newapi_compat_llm',
    displayName: 'New API 兼容',
    preset: 'newapi_compat',
  }),
  defineLlmFactoryMeta({
    name: 'cherryin_compat_llm',
    displayName: 'CherryIN 兼容',
    preset: 'cherryin_compat',
  }),
  defineLlmFactoryMeta({
    name: 'ollama_compat_llm',
    displayName: 'Ollama 兼容',
    preset: 'ollama_compat',
  }),
  defineLlmFactoryMeta({
    name: 'gemini_compat_llm',
    displayName: 'Gemini 兼容',
    preset: 'gemini_compat',
  }),
  defineLlmFactoryMeta({
    name: 'anthropic_compat_llm',
    displayName: 'Anthropic 兼容',
    preset: 'anthropic_compat',
  }),
  defineLlmFactoryMeta({
    name: 'azure_openai_compat_llm',
    displayName: 'Azure OpenAI 兼容',
    preset: 'azure_openai_compat',
  }),
];

export function llmFactoryConfigFiles() {
  const map: any = {};
  for (const meta of LLM_FACTORY_METAS) {
    map[meta.name] = meta;
  }
  return map;
}
