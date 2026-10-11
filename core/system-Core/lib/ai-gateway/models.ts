import LLMFactory from '#factory/llm/LLMFactory.js';
import AiWorkflowLoader from '#infrastructure/ai-workflow/loader.js';
import { getAiWorkflowConfigOptional } from '#utils/ai-workflow-config.js';
import { getDefaultProvider } from '#utils/http/ai-v3-utils.js';

export function listProviderModelIds() {
  const profiles = LLMFactory.listModelProfiles();
  const keys = profiles.map((p) => p.key).filter(Boolean);
  const fallback = getDefaultProvider();
  return keys.length ? keys : (fallback ? [fallback] : []);
}

/** OpenAI GET /v1/models */
export function buildOpenAIModelsPayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: listProviderModelIds().map((id) => ({
      id,
      object: 'model',
      created: now,
      owned_by: 'xrk-agt'
    }))
  };
}

export function buildOpenAIModelPayload(modelId: any) {
  const id = String(modelId || '').trim();
  if (!id) return null;
  const known = listProviderModelIds();
  if (!known.includes(id) && !LLMFactory.hasProvider(id)) return null;
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'xrk-agt'
  };
}

/** 控制台 LLM 选择器（非 OpenAI 列表形态） */
export function buildConsoleLlmCatalog() {
  const llm = getAiWorkflowConfigOptional().llm || {};
  const defaultProvider = getDefaultProvider();
  const profiles = LLMFactory.listModelProfiles();
  const vendors = LLMFactory.listVendors(profiles);

  const workflows = AiWorkflowLoader.getWorkflowsByPriority()
    .filter((s) => !s.primaryStream && !s.secondaryStreams && (s.mcpTools?.size || 0) > 0)
    .map((s) => ({
      key: s.name,
      label: s.description || s.name,
      description: s.description || '',
      profile: null,
      persona: null,
      uiHidden: false
    }));

  const remoteServers = AiWorkflowLoader.listRemoteMCPServers?.() || [];
  const remoteWorkflows = remoteServers.map((name: any) => ({
    key: `remote-mcp.${name}`,
    label: `远程 MCP：${name}`,
    description: `远程 MCP 服务器 ${name}`,
    profile: null,
    persona: null,
    uiHidden: false
  }));

  return {
    enabled: llm.enabled !== false,
    defaultProfile: defaultProvider,
    defaultWorkflow: null,
    persona: llm.persona || '',
    profiles,
    vendors,
    workflows: [...workflows, ...remoteWorkflows]
  };
}
