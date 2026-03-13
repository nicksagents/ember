export type ProviderType =
  | "openai-compatible"
  | "openai-codex"
  | "anthropic"
  | "custom";
export type ProviderAuthType =
  | "none"
  | "api-key"
  | "env"
  | "codex-oauth"
  | "claude-code-oauth";

export interface ProviderSamplingDefaults {
  temperature: number;
  top_p: number;
  max_tokens: number;
}

export interface RuntimeProfile {
  temperature: number;
  top_p: number;
  max_tokens: number;
  toolMode: "native" | "xml" | "prompt";
  contextWindow: number;
  matchedPrefix?: string;
}

/** Client-side runtime profile lookup (mirrors agent/provider-registry.mjs) */
const CLIENT_RUNTIME_PROFILES: Record<string, Omit<RuntimeProfile, "matchedPrefix">> = {
  "claude-opus":       { temperature: 0.3, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 200000 },
  "claude-sonnet":     { temperature: 0.4, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 200000 },
  "claude-haiku":      { temperature: 0.3, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 200000 },
  "gpt-5.3-codex":     { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5.2-codex":     { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5.1-codex":     { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5-mini":        { temperature: 0.4, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 272000 },
  "o3":                { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 200000 },
  "o4-mini":           { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 200000 },
  "gpt-4.1":          { temperature: 0.2, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 1000000 },
  "gpt-4o":           { temperature: 0.3, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "gpt-4.5":          { temperature: 0.3, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 128000 },
  "deepseek-chat":     { temperature: 0.5, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "deepseek-reasoner": { temperature: 0.0, top_p: 1.0, max_tokens: 8192,  toolMode: "native", contextWindow: 128000 },
  "gemini-3":          { temperature: 0.4, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 1000000 },
  "gemini-2":          { temperature: 0.4, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 1000000 },
  "moonshot":          { temperature: 0.5, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "kimi":              { temperature: 0.5, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "qwen":              { temperature: 0.7, top_p: 0.8, max_tokens: 2048,  toolMode: "xml",    contextWindow: 28660 },
};

const _sortedClientProfileKeys = Object.keys(CLIENT_RUNTIME_PROFILES)
  .sort((a, b) => b.length - a.length);

export function getClientRuntimeProfile(modelId: string): RuntimeProfile | null {
  const id = (modelId || "").toLowerCase();
  for (const prefix of _sortedClientProfileKeys) {
    if (id.startsWith(prefix) || id.includes(prefix)) {
      return { ...CLIENT_RUNTIME_PROFILES[prefix], matchedPrefix: prefix };
    }
  }
  return null;
}

export function formatContextWindow(ctx: number): string {
  if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
  if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
  return String(ctx);
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  endpoint: string;
  apiKey: string;
  apiKeyEnvVar: string;
  authType: ProviderAuthType;
  models: string[];
  defaultModel: string;
  maxContextWindow: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsBrowser: boolean;
  enabled: boolean;
  modelsEndpoint?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number | null;
  oauthAccountId?: string;
  oauthIdToken?: string;
  samplingDefaults: ProviderSamplingDefaults;
}

export interface ProviderCatalogEntry {
  id: string;
  description: string;
  authOptions: ProviderAuthType[];
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  envVarPlaceholder: string;
  oauthLabel?: string;
  oauthTokenLabel?: string;
  oauthTokenPlaceholder?: string;
  oauthHelpText?: string;
  provider: ProviderConfig;
}

export interface RoleAssignment {
  providerId: string;
  model: string;
}

export interface RoleAssignments {
  default: RoleAssignment;
  planner: RoleAssignment;
  coder: RoleAssignment;
  auditor: RoleAssignment;
  maintenance: RoleAssignment;
  router: RoleAssignment;
}

export type PayloadCompatDisabledParams = Record<string, string[]>;

export interface AgentConfig {
  provider: string;
  endpoint: string;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repetition_penalty: number;
  max_tokens: number;
  contextWindow: number;
  model: string;
  statelessProvider: boolean;
  unrestrictedShell: boolean;
  webSearchEnabled: boolean;
  toolMode: string;
  toolTemperature: number;
  toolTopK: number;
  toolRepetitionPenalty: number;
  maxToolRounds: number;
  lightweightMode: boolean;
  maxMemoryItems: number;
  maxMemoryChars: number;
  contextCharBudget: number;
  corePrompt: string;
  userMd: string;
  soulMd: string;
  githubUsername: string;
  githubEmail: string;
  githubToken: string;
  modelRoles: {
    assistant: string;
    planner: string;
    coder: string;
    critic: string;
    classifier: string;
  };
  providers: ProviderConfig[];
  roleAssignments: RoleAssignments;
  payloadCompatDisabledParams: PayloadCompatDisabledParams;
}

const LOCAL_QWEN_MODEL = "Qwen3-Coder-30B-A3B-Instruct-Q8_0";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
];
const OPENAI_API_MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4.1-mini"];
const ANTHROPIC_MODELS = ["claude-sonnet-4-5", "claude-opus-4-6"];
const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner"];
const GEMINI_MODELS = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const MOONSHOT_MODELS = ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"];
const KIMI_MODELS = ["kimi-k2-0905-preview", "kimi-k2-turbo-preview"];

export function normalizeProviderId(providerId: string): string {
  const id = (providerId || "").trim().toLowerCase();
  if (!id) return "";
  if (id === "codex") return OPENAI_CODEX_PROVIDER_ID;
  return id;
}

export const PROVIDER_LIBRARY: ProviderCatalogEntry[] = [
  {
    id: "local-qwen",
    description: "Local llama.cpp / OpenAI-compatible endpoint with no cloud auth.",
    authOptions: ["none"],
    apiKeyLabel: "API key",
    apiKeyPlaceholder: "",
    envVarPlaceholder: "",
    provider: {
      id: "local-qwen",
      name: "Local Qwen (llama.cpp)",
      type: "openai-compatible",
      endpoint: "http://100.124.19.71:8080/v1/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "none",
      models: [LOCAL_QWEN_MODEL],
      defaultModel: LOCAL_QWEN_MODEL,
      maxContextWindow: 28660,
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: true,
      modelsEndpoint: "http://100.124.19.71:8080/v1/models",
      samplingDefaults: {
        temperature: 0.7,
        top_p: 0.8,
        max_tokens: 0,
      },
    },
  },
  {
    id: "anthropic",
    description:
      "Claude models using an Anthropic API key or a Claude setup-token stored in Ember.",
    authOptions: ["claude-code-oauth", "api-key", "env"],
    apiKeyLabel: "Anthropic API key",
    apiKeyPlaceholder: "sk-ant-api03-...",
    envVarPlaceholder: "ANTHROPIC_API_KEY",
    oauthLabel: "Claude setup-token",
    oauthTokenLabel: "Anthropic setup-token",
    oauthTokenPlaceholder: "Paste the token from `claude setup-token`",
    oauthHelpText:
      "Run `claude setup-token`, then paste the generated token here. Ember stores and uses it directly.",
    provider: {
      id: "anthropic",
      name: "Anthropic",
      type: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "claude-code-oauth",
      models: ANTHROPIC_MODELS,
      defaultModel: "claude-sonnet-4-5",
      maxContextWindow: 200000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      samplingDefaults: {
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 4096,
      },
    },
  },
  {
    id: OPENAI_CODEX_PROVIDER_ID,
    description:
      "OpenAI Codex via browser OAuth or imported Codex credentials, with Codex-specific model discovery.",
    authOptions: ["codex-oauth", "api-key", "env"],
    apiKeyLabel: "OpenAI API token",
    apiKeyPlaceholder: "sk-proj-...",
    envVarPlaceholder: "OPENAI_API_KEY",
    oauthLabel: "OpenAI Codex OAuth",
    oauthTokenLabel: "OpenAI access token",
    oauthTokenPlaceholder: "OpenAI Codex OAuth stores the access token for you",
    oauthHelpText:
      "Use Sign in with OpenAI to run the built-in Codex browser OAuth flow. Ember stores the resulting access token and refresh credentials directly.",
    provider: {
      id: OPENAI_CODEX_PROVIDER_ID,
      name: "OpenAI Codex",
      type: "openai-codex",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "codex-oauth",
      models: OPENAI_CODEX_MODELS,
      defaultModel: "gpt-5.3-codex",
      maxContextWindow: 272000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: true,
      enabled: false,
      modelsEndpoint: "",
      samplingDefaults: {
        temperature: 1,
        top_p: 1,
        max_tokens: 16384,
      },
    },
  },
  {
    id: "openai",
    description: "OpenAI API models using an API token or environment variable.",
    authOptions: ["api-key", "env"],
    apiKeyLabel: "OpenAI API token",
    apiKeyPlaceholder: "sk-proj-...",
    envVarPlaceholder: "OPENAI_API_KEY",
    provider: {
      id: "openai",
      name: "OpenAI API",
      type: "openai-compatible",
      endpoint: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "api-key",
      models: OPENAI_API_MODELS,
      defaultModel: "gpt-5-mini",
      maxContextWindow: 272000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      modelsEndpoint: "https://api.openai.com/v1/models",
      samplingDefaults: {
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 8192,
      },
    },
  },
  {
    id: "moonshot",
    description: "Moonshot AI platform models with a Moonshot API key.",
    authOptions: ["api-key", "env"],
    apiKeyLabel: "Moonshot API key",
    apiKeyPlaceholder: "sk-moonshot-...",
    envVarPlaceholder: "MOONSHOT_API_KEY",
    provider: {
      id: "moonshot",
      name: "Moonshot",
      type: "openai-compatible",
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "api-key",
      models: MOONSHOT_MODELS,
      defaultModel: "moonshot-v1-128k",
      maxContextWindow: 128000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      modelsEndpoint: "https://api.moonshot.ai/v1/models",
      samplingDefaults: {
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 4096,
      },
    },
  },
  {
    id: "deepseek",
    description: "DeepSeek chat and reasoning models with a DeepSeek API key.",
    authOptions: ["api-key", "env"],
    apiKeyLabel: "DeepSeek API key",
    apiKeyPlaceholder: "sk-deepseek-...",
    envVarPlaceholder: "DEEPSEEK_API_KEY",
    provider: {
      id: "deepseek",
      name: "DeepSeek",
      type: "openai-compatible",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "api-key",
      models: DEEPSEEK_MODELS,
      defaultModel: "deepseek-chat",
      maxContextWindow: 128000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      modelsEndpoint: "https://api.deepseek.com/v1/models",
      samplingDefaults: {
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 4096,
      },
    },
  },
  {
    id: "gemini",
    description: "Google Gemini models with a Google AI Studio or Gemini API key.",
    authOptions: ["api-key", "env"],
    apiKeyLabel: "Gemini API key",
    apiKeyPlaceholder: "AIza...",
    envVarPlaceholder: "GEMINI_API_KEY",
    provider: {
      id: "gemini",
      name: "Gemini",
      type: "openai-compatible",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "api-key",
      models: GEMINI_MODELS,
      defaultModel: "gemini-2.5-pro",
      maxContextWindow: 1000000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      modelsEndpoint: "https://generativelanguage.googleapis.com/v1beta/openai/models",
      samplingDefaults: {
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 4096,
      },
    },
  },
  {
    id: "kimi",
    description: "Kimi coding and chat models on Moonshot with a Moonshot API key.",
    authOptions: ["api-key", "env"],
    apiKeyLabel: "Moonshot API key",
    apiKeyPlaceholder: "sk-moonshot-...",
    envVarPlaceholder: "MOONSHOT_API_KEY",
    provider: {
      id: "kimi",
      name: "Kimi K2.5",
      type: "openai-compatible",
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      apiKey: "",
      apiKeyEnvVar: "",
      authType: "api-key",
      models: KIMI_MODELS,
      defaultModel: "kimi-k2-0905-preview",
      maxContextWindow: 128000,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      enabled: false,
      modelsEndpoint: "https://api.moonshot.ai/v1/models",
      samplingDefaults: {
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 4096,
      },
    },
  },
];

export const DEFAULT_PROVIDERS: ProviderConfig[] = PROVIDER_LIBRARY.map(
  (entry) => entry.provider
);

export const DEFAULT_ROLE_ASSIGNMENTS: RoleAssignments = {
  default: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
  planner: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
  coder: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
  auditor: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
  maintenance: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
  router: {
    providerId: "local-qwen",
    model: LOCAL_QWEN_MODEL,
  },
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: "local-qwen",
  endpoint: "http://100.124.19.71:8080/v1/chat/completions",
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.05,
  repetition_penalty: 1.05,
  max_tokens: 0,
  contextWindow: 28660,
  model: LOCAL_QWEN_MODEL,
  statelessProvider: true,
  unrestrictedShell: false,
  webSearchEnabled: true,
  toolMode: "auto",
  toolTemperature: 0.35,
  toolTopK: 8,
  toolRepetitionPenalty: 1.2,
  maxToolRounds: 48,
  lightweightMode: false,
  maxMemoryItems: 10,
  maxMemoryChars: 2000,
  contextCharBudget: 28000,
  corePrompt:
    "You are Ember, a local agent runtime. Be direct, practical, and honest.",
  userMd: "",
  soulMd: "You are funny, concise, and helpful.",
  githubUsername: "",
  githubEmail: "",
  githubToken: "",
  modelRoles: {
    assistant: LOCAL_QWEN_MODEL,
    planner: LOCAL_QWEN_MODEL,
    coder: LOCAL_QWEN_MODEL,
    critic: LOCAL_QWEN_MODEL,
    classifier: LOCAL_QWEN_MODEL,
  },
  providers: [DEFAULT_PROVIDERS[0]],
  roleAssignments: DEFAULT_ROLE_ASSIGNMENTS,
  payloadCompatDisabledParams: {},
};

export const AUTH_TYPE_OPTIONS = [
  { id: "none", label: "No auth" },
  { id: "api-key", label: "Manual API key" },
  { id: "env", label: "Environment variable" },
  { id: "claude-code-oauth", label: "Anthropic setup-token" },
  { id: "codex-oauth", label: "OpenAI Codex OAuth" },
] as const;

export function getProviderCatalogEntry(providerId: string) {
  const normalizedId = normalizeProviderId(providerId);
  return PROVIDER_LIBRARY.find((entry) => entry.id === normalizedId) || null;
}

export function cloneProviders(providers: ProviderConfig[] = DEFAULT_PROVIDERS) {
  return JSON.parse(JSON.stringify(providers)) as ProviderConfig[];
}

export function cloneRoleAssignments(
  assignments: RoleAssignments = DEFAULT_ROLE_ASSIGNMENTS
) {
  return JSON.parse(JSON.stringify(assignments)) as RoleAssignments;
}

export function getProviderModelsUrl(provider: ProviderConfig): string {
  if (provider.modelsEndpoint?.trim()) return provider.modelsEndpoint.trim();
  return getModelsUrl(provider.endpoint);
}

export function getModelsUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const nextPath = url.pathname
      .replace(/\/v1\/chat\/completions$/, "/v1/models")
      .replace(/\/v1\/responses$/, "/v1/models");
    url.pathname = nextPath === url.pathname ? "/v1/models" : nextPath;
    return url.toString();
  } catch {
    const base = endpoint.replace(/\/v1\/.*$/, "");
    return `${base}/v1/models`;
  }
}
