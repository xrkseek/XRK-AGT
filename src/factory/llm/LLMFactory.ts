import VolcengineLLMClient from './VolcengineLLMClient.js';
import DeepSeekLLMClient from './DeepSeekLLMClient.js';
import XiaomiMiMoLLMClient from './XiaomiMiMoLLMClient.js';
import OpenAILLMClient from './OpenAILLMClient.js';
import GeminiLLMClient from './GeminiLLMClient.js';
import AnthropicLLMClient from './AnthropicLLMClient.js';
import AzureOpenAILLMClient from './AzureOpenAILLMClient.js';
import OpenAICompatibleLLMClient from './OpenAICompatibleLLMClient.js';
import OpenAIResponsesCompatibleLLMClient from './OpenAIResponsesCompatibleLLMClient.js';
import OpenAIPathCompatLLMClient from './OpenAIPathCompatLLMClient.js';
import OllamaCompatibleLLMClient from './OllamaCompatibleLLMClient.js';
import GeminiCompatibleLLMClient from './GeminiCompatibleLLMClient.js';
import AnthropicCompatibleLLMClient from './AnthropicCompatibleLLMClient.js';
import AzureOpenAICompatibleLLMClient from './AzureOpenAICompatibleLLMClient.js';
import runtimeConfig from '#infrastructure/config/config.js';
import { assertProviderAllowed } from '#utils/runtime-policy.js';

type LlmClientConfig = Record<string, unknown>;
type ClientFactory = (config: LlmClientConfig) => unknown;
type CompatClientClass = new (config: LlmClientConfig) => unknown;

type FactoryType = 'builtin' | 'compat';

type FactoryRegistryEntry = {
  configKey: string;
  factoryType: FactoryType;
  protocol?: string;
  defaultProtocol?: string;
  displayName: string;
  clientClass?: CompatClientClass;
};

type ProviderYamlEntry = Record<string, unknown> & {
  key?: unknown;
  provider?: unknown;
  protocol?: unknown;
  label?: unknown;
  model?: unknown;
  chatModel?: unknown;
  deployment?: unknown;
  baseUrl?: unknown;
  maxTokens?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  apiKey?: unknown;
  enableStream?: unknown;
  enableTools?: unknown;
};

type ProviderEntry = {
  key: string;
  protocol: string;
  factory: FactoryRegistryEntry;
  entry: ProviderYamlEntry;
};

type ModelProfile = {
  key: string;
  factory: string;
  factoryConfigKey: string;
  factoryDisplayName: string;
  factoryType: FactoryType;
  protocol: string;
  label: string;
  description: string;
  tags: string[];
  model: unknown;
  baseUrl: unknown;
  maxTokens: unknown;
  temperature: unknown;
  hasApiKey: boolean;
  capabilities: string[];
  source: string;
};

type ModelProfileFilter = {
  protocol?: string | string[];
  hasApiKey?: boolean;
  capability?: string;
  factory?: string | string[];
};

type FactoryListItem = {
  configKey: string;
  id: string;
  displayName: string;
  factoryType: FactoryType;
  protocol: string | null;
};

type VendorEndpoint = {
  key: string;
  label: string;
  model: unknown;
  baseUrl: unknown;
  protocol: string;
  hasApiKey: boolean;
  capabilities: string[];
};

type VendorBucket = {
  id: string;
  label: string;
  configKey: string;
  factoryType: FactoryType;
  protocol: string | null;
  endpoints: VendorEndpoint[];
};

type ResolveProviderInput = {
  provider?: unknown;
  model?: unknown;
  llm?: unknown;
  profile?: unknown;
  defaultProvider?: unknown;
};

type ResolveProviderOptions = {
  allowDefaultAliases?: boolean;
  useAistreamDefault?: boolean;
};

type CreateClientConfig = ResolveProviderInput &
  Record<string, unknown> & {
    useAistreamDefault?: boolean;
    allowDefaultAliases?: boolean;
    protocol?: unknown;
  };

type ProviderResolvedConfig = ProviderYamlEntry & {
  provider: string;
  protocol: string;
  factoryType: FactoryType;
  factory: string;
  _clientClass: CompatClientClass | null;
};

const builtinClientFactories = new Map<string, ClientFactory>([
  // builtin：各厂商官方 SDK/文档路径，禁止与 openai_compat 混用
  ['volcengine', (config) => new VolcengineLLMClient(config)],
  ['deepseek', (config) => new DeepSeekLLMClient(config)],
  ['xiaomimimo', (config) => new XiaomiMiMoLLMClient(config)],
  ['openai', (config) => new OpenAILLMClient(config)],
  ['gemini', (config) => new GeminiLLMClient(config)],
  ['anthropic', (config) => new AnthropicLLMClient(config)],
  ['azure_openai', (config) => new AzureOpenAILLMClient(config)],
]);

/** configKey → 侧栏工厂 id（anthropic_compat_llm → anthropic_compat，anthropic_llm → anthropic） */
export function resolveFactoryId(configKey: unknown = ''): string {
  const key = String(configKey || '').trim();
  if (!key) return '';
  if (key.endsWith('_llm')) return key.slice(0, -4);
  return key;
}

/** 读取工厂 YAML（须走 runtimeConfig.getConfig； bracket 访问对多数 *_compat_llm 无效） */
function readFactoryCfg(configKey: unknown): Record<string, unknown> {
  if (!configKey || typeof runtimeConfig?.getConfig !== 'function') return {};
  const cfg = runtimeConfig.getConfig(String(configKey));
  return cfg && typeof cfg === 'object' ? cfg : {};
}

/** 所有 LLM 工厂统一从 providers[] 解析；YAML 默认仅 providers: []（顺序与原版一致） */
const factoryRegistry: FactoryRegistryEntry[] = [
  { configKey: 'volcengine_llm', factoryType: 'builtin', protocol: 'volcengine', displayName: '火山引擎（官方）' },
  { configKey: 'deepseek_llm', factoryType: 'builtin', protocol: 'deepseek', displayName: 'DeepSeek（官方）' },
  { configKey: 'xiaomimimo_llm', factoryType: 'builtin', protocol: 'xiaomimimo', displayName: '小米 MiMo（官方）' },
  { configKey: 'openai_llm', factoryType: 'builtin', protocol: 'openai', displayName: 'OpenAI（官方）' },
  { configKey: 'gemini_llm', factoryType: 'builtin', protocol: 'gemini', displayName: 'Gemini（官方）' },
  { configKey: 'anthropic_llm', factoryType: 'builtin', protocol: 'anthropic', displayName: 'Anthropic（官方）' },
  { configKey: 'azure_openai_llm', factoryType: 'builtin', protocol: 'azure_openai', displayName: 'Azure OpenAI（官方）' },
  { configKey: 'openai_compat_llm', factoryType: 'compat', defaultProtocol: 'openai', displayName: 'OpenAI Chat 兼容', clientClass: OpenAICompatibleLLMClient },
  { configKey: 'openai_responses_compat_llm', factoryType: 'compat', defaultProtocol: 'openai-response', displayName: 'OpenAI Responses 兼容', clientClass: OpenAIResponsesCompatibleLLMClient },
  { configKey: 'newapi_compat_llm', factoryType: 'compat', defaultProtocol: 'new-api', displayName: 'New API 兼容', clientClass: OpenAIPathCompatLLMClient },
  { configKey: 'cherryin_compat_llm', factoryType: 'compat', defaultProtocol: 'cherryin', displayName: 'CherryIN 兼容', clientClass: OpenAIPathCompatLLMClient },
  { configKey: 'ollama_compat_llm', factoryType: 'compat', defaultProtocol: 'ollama', displayName: 'Ollama 兼容', clientClass: OllamaCompatibleLLMClient },
  { configKey: 'gemini_compat_llm', factoryType: 'compat', defaultProtocol: 'gemini', displayName: 'Gemini 兼容', clientClass: GeminiCompatibleLLMClient },
  { configKey: 'anthropic_compat_llm', factoryType: 'compat', defaultProtocol: 'anthropic', displayName: 'Anthropic 兼容', clientClass: AnthropicCompatibleLLMClient },
  { configKey: 'azure_openai_compat_llm', factoryType: 'compat', defaultProtocol: 'azure-openai', displayName: 'Azure OpenAI 兼容', clientClass: AzureOpenAICompatibleLLMClient },
];

function normalizeProviderKey(name: unknown): string {
  return (name || '').toString().trim().toLowerCase();
}

function resolveDefaultProvider(): string {
  const llm = (runtimeConfig.aiWorkflow?.llm ?? {}) as Record<string, unknown>;
  return normalizeProviderKey(llm.Provider ?? llm.provider);
}

function normalizeProtocol(value: unknown): string {
  const protocol = normalizeProviderKey(value);
  if (protocol === 'openai-responses') return 'openai-response';
  return protocol;
}

function getProviderEntries(): ProviderEntry[] {
  const entries: ProviderEntry[] = [];

  for (const factory of factoryRegistry) {
    const factoryCfg = readFactoryCfg(factory.configKey);
    const providerList = Array.isArray(factoryCfg.providers) ? factoryCfg.providers : [];

    for (const raw of providerList) {
      if (!raw || typeof raw !== 'object') continue;
      const providerEntry = raw as ProviderYamlEntry;
      const key = normalizeProviderKey(providerEntry.key || providerEntry.provider);
      if (!key) continue;

      const protocol = normalizeProtocol(
        providerEntry.protocol || factory.protocol || factory.defaultProtocol,
      );

      entries.push({
        key,
        protocol,
        factory,
        entry: providerEntry,
      });
    }
  }

  return entries;
}

export default class LLMFactory {
  static registerProvider(name: unknown, factoryFn: ClientFactory): void {
    builtinClientFactories.set(String(name).toLowerCase(), factoryFn);
  }

  static listProviders(): string[] {
    return getProviderEntries().map((x) => x.key);
  }

  static listFactories(): FactoryListItem[] {
    return factoryRegistry.map((factory) => ({
      configKey: factory.configKey,
      id: resolveFactoryId(factory.configKey),
      displayName: factory.displayName || resolveFactoryId(factory.configKey),
      factoryType: factory.factoryType,
      protocol: factory.protocol || factory.defaultProtocol || null,
    }));
  }

  /** 控制台 /api/ai/models 用的 profile 列表（含 capabilities 等运行时字段） */
  static listModelProfiles(filter: ModelProfileFilter = {}): ModelProfile[] {
    const rows = getProviderEntries().map(({ key, protocol, factory, entry }): ModelProfile => ({
      key,
      factory: resolveFactoryId(factory.configKey),
      factoryConfigKey: factory.configKey,
      factoryDisplayName: factory.displayName || resolveFactoryId(factory.configKey),
      factoryType: factory.factoryType,
      protocol,
      label: String(entry.label || key),
      description: `配置来源: ${factory.configKey}.providers[]`,
      tags: [],
      model: entry.model || entry.chatModel || entry.deployment || null,
      baseUrl: entry.baseUrl || null,
      maxTokens: entry.maxTokens ?? entry.max_tokens ?? null,
      temperature: entry.temperature ?? null,
      hasApiKey: Boolean(String(entry.apiKey || '').trim()),
      capabilities: [
        ...(entry.enableStream !== false ? ['stream'] : []),
        ...(entry.enableTools === true ? ['tools'] : []),
      ],
      source: `${factory.configKey}.providers[]`,
    }));

    let result = rows;
    if (filter.protocol) {
      const protos = Array.isArray(filter.protocol) ? filter.protocol : [filter.protocol];
      const set = new Set(protos.map((p) => normalizeProtocol(p)));
      result = result.filter((row) => set.has(normalizeProtocol(row.protocol)));
    }
    if (filter.hasApiKey === true) {
      result = result.filter((row) => row.hasApiKey);
    }
    if (filter.capability) {
      const capability = filter.capability
      result = result.filter((row) => row.capabilities?.includes(capability));
    }
    if (filter.factory) {
      const factories = Array.isArray(filter.factory) ? filter.factory : [filter.factory];
      const set = new Set(factories.map((f) => normalizeProviderKey(f)));
      result = result.filter((row) => set.has(normalizeProviderKey(row.factory)));
    }
    return result;
  }

  /** 侧栏 LLM 工厂 → 端点分组（与 listFactories 顺序一致） */
  static listVendors(profiles: ModelProfile[] | null = null): VendorBucket[] {
    const rows = profiles ?? this.listModelProfiles();
    const vendorMap = new Map<string, VendorBucket>(
      this.listFactories().map((factory) => [
        factory.id,
        {
          id: factory.id,
          label: factory.displayName,
          configKey: factory.configKey,
          factoryType: factory.factoryType,
          protocol: factory.protocol,
          endpoints: [],
        },
      ]),
    );
    for (const p of rows) {
      const bucket = vendorMap.get(p.factory);
      if (!bucket) continue;
      bucket.endpoints.push({
        key: p.key,
        label: p.label,
        model: p.model,
        baseUrl: p.baseUrl,
        protocol: p.protocol,
        hasApiKey: p.hasApiKey,
        capabilities: p.capabilities,
      });
    }
    const order = this.listFactories().map((f) => f.id);
    return [...vendorMap.values()].sort(
      (a, b) =>
        (order.indexOf(a.id) === -1 ? order.length : order.indexOf(a.id)) -
        (order.indexOf(b.id) === -1 ? order.length : order.indexOf(b.id)),
    );
  }

  static hasProvider(name: unknown): boolean {
    return !!this.getProviderConfig(name);
  }

  static resolveProvider(
    input: ResolveProviderInput = {},
    options: ResolveProviderOptions = {},
  ): string | null {
    const allowDefaultAliases = options.allowDefaultAliases !== false;
    const useAistreamDefault = options.useAistreamDefault !== false;
    const isDefaultAlias = (v: unknown) => {
      const s = normalizeProviderKey(v);
      return s === 'default' || s === 'auto';
    };

    const candidates: unknown[] = [
      input.provider,
      input.model,
      input.llm,
      input.profile,
      input.defaultProvider,
    ];
    if (useAistreamDefault) {
      candidates.push(resolveDefaultProvider());
    }

    for (const candidate of candidates) {
      const key = normalizeProviderKey(candidate);
      if (!key) continue;
      if (allowDefaultAliases && isDefaultAlias(key)) continue;
      if (this.hasProvider(key)) return key;
    }

    return null;
  }

  static getProviderConfig(providerName: unknown): ProviderResolvedConfig | null {
    const key = normalizeProviderKey(providerName);
    if (!key) return null;

    const matched = getProviderEntries().find((x) => x.key === key);
    if (!matched) return null;

    const { factory, entry, protocol } = matched;

    return {
      ...entry,
      provider: key,
      protocol,
      factoryType: factory.factoryType,
      factory: resolveFactoryId(factory.configKey),
      _clientClass: factory.clientClass || null,
    };
  }

  static createClient(config: CreateClientConfig = {}): unknown {
    const useAistreamDefault = config.useAistreamDefault !== false;
    const provider = this.resolveProvider(config, {
      allowDefaultAliases: config.allowDefaultAliases !== false,
      useAistreamDefault,
    });
    if (!provider) {
      const hint = useAistreamDefault
        ? '请在各工厂 providers[] 中添加端点，并在 ai-workflow.yaml 配置 llm.Provider'
        : '请在各工厂 providers[] 中添加端点，并在请求中指定 provider';
      throw new Error(`未指定 LLM 提供商：${hint}`);
    }

    assertProviderAllowed(provider);

    const resolved = this.getProviderConfig(provider);
    if (!resolved) {
      throw new Error(`不支持的 LLM 提供商: ${provider}`);
    }

    const sanitizedConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config || {})) {
      if (value !== undefined) {
        sanitizedConfig[key] = value;
      }
    }

    const clientConfig: ProviderResolvedConfig & Record<string, unknown> = {
      ...resolved,
      ...sanitizedConfig,
      provider,
      protocol: normalizeProtocol(sanitizedConfig.protocol || resolved.protocol) || resolved.protocol,
    };

    const { _clientClass, factoryType, ...rest } = clientConfig;

    if (factoryType === 'compat' && _clientClass) {
      return new _clientClass(rest);
    }

    const builtinFactory = builtinClientFactories.get(String(rest.protocol));
    if (builtinFactory) {
      return builtinFactory(rest);
    }

    return new (_clientClass || OpenAICompatibleLLMClient)(rest as any);
  }
}
