/**
 * AiWorkflow 配置工具
 * 统一 LLM/ASR/TTS 配置读取，供 device、xiaozhi、workflow 等模块复用
 */
import runtimeConfig from '#infrastructure/config/config.js';

type RuntimeConfigLike = {
  aiWorkflow?: Record<string, any>;
  volcengine_tts?: Record<string, unknown>;
  volcengine_asr?: Record<string, unknown>;
  device?: Record<string, unknown>;
};

const cfg = () => runtimeConfig as RuntimeConfigLike;

const ensureConfig = <T>(value: T | undefined, configPath: string): T => {
  if (value === undefined) {
    throw new Error(`配置缺失: ${configPath}`);
  }
  return value;
};

export const getAiWorkflowConfig = (): Record<string, any> =>
  ensureConfig(cfg().aiWorkflow, 'ai-workflow');

/** 可选读取：无 ai-workflow 时返回 {}，供 loader/mcp/debug 等使用 */
export const getAiWorkflowConfigOptional = (): Record<string, any> => cfg().aiWorkflow ?? {};

/**
 * 获取 LLM 调用配置。底层工厂用 ai-workflow.llm.Provider + runtimeConfig[Provider]_llm，不依赖 profiles。
 * 有 profiles/models 时做工作流/预设合并；没有时直接用 llm 段（Provider、timeout、persona 等）。
 */
export const getLLMSettings = ({
  workflow,
  persona,
  profile,
}: {
  workflow?: string;
  persona?: unknown;
  profile?: string;
} = {}): Record<string, unknown> => {
  const section = ensureConfig(getAiWorkflowConfig().llm, 'ai-workflow.llm') as Record<string, any>;
  if (section.enabled === false) return { enabled: false };

  const profiles = section.profiles || section.models;
  const hasProfiles = profiles && typeof profiles === 'object' && Object.keys(profiles).length > 0;

  if (!hasProfiles) {
    const provider = (section.Provider || section.provider || '').toLowerCase();
    return {
      enabled: true,
      workflow: workflow || section.defaultWorkflow || 'device',
      workflowKey: workflow || 'device',
      profile: null,
      profileKey: null,
      profileLabel: null,
      persona: persona ?? section.persona,
      displayDelay: section.displayDelay,
      ...section.defaults,
      ...section,
      provider: provider || undefined,
    };
  }

  const defaults = section.defaults || {};
  const workflows = section.workflows || {};
  const workflowKey =
    workflow ||
    section.defaultWorkflow ||
    section.defaultModel ||
    Object.keys(workflows)[0] ||
    Object.keys(profiles)[0];
  const workflowPreset = workflowKey ? workflows[workflowKey] : null;
  const requestedProfile =
    profile || workflowPreset?.profile || section.defaultProfile || section.defaultModel;
  const profileKey = profiles[requestedProfile] ? requestedProfile : Object.keys(profiles)[0];
  const selectedProfile = profiles[profileKey];
  if (!selectedProfile) return { enabled: false };
  const overrides = workflowPreset?.overrides || {};
  const personaResolved = persona ?? workflowPreset?.persona ?? section.persona;

  return {
    enabled: true,
    workflow: workflowKey,
    workflowKey,
    workflowLabel: workflowPreset?.label || workflowKey,
    profile: profileKey,
    profileKey,
    profileLabel: selectedProfile.label || profileKey,
    persona: personaResolved,
    displayDelay: section.displayDelay,
    ...defaults,
    ...selectedProfile,
    ...overrides,
  };
};

export const getTtsConfig = (): Record<string, unknown> => {
  const aiWorkflow = getAiWorkflowConfig();
  const section = aiWorkflow.tts || {};
  if (section.enabled === false) return { enabled: false };

  const provider = (section.Provider || section.provider || 'volcengine').toLowerCase();
  if (provider !== 'volcengine') throw new Error(`不支持的TTS提供商: ${provider}`);

  const baseConfig = ensureConfig(cfg().volcengine_tts, 'volcengine_tts');
  return { enabled: true, provider, ...baseConfig };
};

export const getAsrConfig = (): Record<string, unknown> => {
  const aiWorkflow = getAiWorkflowConfig();
  const section = aiWorkflow.asr || {};
  if (section.enabled === false) return { enabled: false };

  const provider = (section.Provider || section.provider || 'volcengine').toLowerCase();
  if (provider !== 'volcengine') throw new Error(`不支持的ASR提供商: ${provider}`);

  const baseConfig = ensureConfig(cfg().volcengine_asr, 'volcengine_asr');
  return { enabled: true, provider, ...baseConfig };
};

export const getSystemConfig = (): Record<string, unknown> => ensureConfig(cfg().device, 'device');
