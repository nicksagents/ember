export interface AgentConfig {
  provider: string;
  endpoint: string;
  temperature: number;
  model: string;
  statelessProvider: boolean;
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
  };
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: "custom",
  endpoint: "http://localhost:8080/v1/chat/completions",
  temperature: 0.7,
  model: "",
  statelessProvider: true,
  corePrompt:
    "You are Ember, a local agent runtime. Be direct, practical, and honest.",
  userMd: "",
  soulMd: "You are funny, concise, and helpful.",
  githubUsername: "",
  githubEmail: "",
  githubToken: "",
  modelRoles: {
    assistant: "",
    planner: "",
    coder: "",
    critic: "",
  },
};

export const PROVIDER_PRESETS = [
  {
    id: "openai",
    label: "OpenAI Compatible",
    endpoint: "http://localhost:8080/v1/chat/completions",
  },
  {
    id: "ollama",
    label: "Ollama",
    endpoint: "http://localhost:11434/v1/chat/completions",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    endpoint: "http://localhost:1234/v1/chat/completions",
  },
  {
    id: "custom",
    label: "Custom",
    endpoint: "",
  },
] as const;

/**
 * Derives the /v1/models URL from the user's chat endpoint.
 */
export function getModelsUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const v1Index = url.pathname.indexOf("/v1/");
    if (v1Index !== -1) {
      url.pathname = url.pathname.substring(0, v1Index) + "/v1/models";
    } else {
      url.pathname = "/v1/models";
    }
    return url.toString();
  } catch {
    const base = endpoint.replace(/\/v1\/.*$/, "").replace(/\/api\/.*$/, "");
    return base + "/v1/models";
  }
}
