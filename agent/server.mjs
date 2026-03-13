#!/usr/bin/env node

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  appendFile,
  writeFile,
  readdir,
  unlink,
  rename,
} from "node:fs/promises";
import {
  validateChatRequest,
  sanitizeConfigInput,
  buildSystemPrompt,
  runToolLoop,
  selectRelevantMemories,
  detectMemoryCandidates,
  detectAssistantFacts,
  detectDiscoveryFacts,
  detectMemoryInvalidations,
  buildEmbedding,
  consolidateMemories,
  selectMemoriesWithFallback,
  inferRelevantMemoryLimit,
  explainMemoryScore,
} from "./core.mjs";
import {
  ToolRegistry,
  registerFilesystemTools,
  loadToolPlugins,
  createFsPolicy,
} from "./tooling.mjs";
import {
  LOCAL_IP_COMMAND,
  TAILSCALE_IPV4_COMMAND,
  HOSTNAME_COMMAND,
  matchesCommandHint,
  classifyLocalMachineInfoTask,
  buildExecutionPlan,
  formatExecutionPlanNote,
} from "./orchestration.mjs";
import {
  isQwenCoderModel,
  buildQwenXmlToolSystemMessage,
  buildQwenToolContinuationPrompt,
} from "./qwen.mjs";
import {
  shouldUsePromptOnlyTools,
  normalizePayloadCompatCache,
  getCachedUnsupportedPayloadParams,
  mergeUnsupportedPayloadParams,
  extractUnsupportedPayloadParams,
  stripUnsupportedPayloadParams,
} from "./provider-compat.mjs";
import {
  extractHtmlTitle,
  extractReadableContent,
  stripHtmlToText,
} from "./web-content.mjs";
import {
  looksLikeEditRequest,
  looksLikeReferentialFilesystemFollowUp,
  extractBareFileReference,
  inferFilesystemTarget,
} from "./filesystem-intent.mjs";
import {
  classifyProcessTask,
  extractRequestedHost,
  extractRequestedPort,
  looksLikeServerTaskRequest,
} from "./process-intent.mjs";
import { ProviderRegistry } from "./provider-registry.mjs";
import { listLocalAuthSources } from "./auth-sources.mjs";
import {
  startOAuthFlow,
  getFlowStatus,
  submitOAuthRedirect,
} from "./codex-oauth.mjs";
import {
  getRole,
  filterToolsForRole,
  canRoleDelegate,
  buildRoleContractPrompt,
} from "./roles.mjs";
import { routeRequest, regexRouteFallback } from "./router.mjs";

const execFileAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────────────────────

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.AGENT_PORT || "4317", 10);
let DATA_DIR = process.env.EMBER_HOME || path.join(os.homedir(), ".ember-agent");
const MAX_BODY_BYTES = Number.parseInt(
  process.env.AGENT_MAX_BODY_BYTES || "1048576",
  10
);
const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.AGENT_REQUEST_TIMEOUT_MS || "120000",
  10
);
const EMBEDDINGS_ENDPOINT = process.env.EMBER_EMBEDDINGS_ENDPOINT || "";
let _chatRequestCount = 0;
const MEMORY_MAINTENANCE_INTERVAL = 10;
const SUMMARY_KEEP_MESSAGES = 32;
const SUMMARY_MIN_MESSAGES = 8;
const SUMMARY_MAX_INPUT_CHARS = 10000;
const SUMMARY_MAX_OUTPUT_CHARS = 1200;
const CONTEXT_CHAR_BUDGET = 28000;
const CHAT_PROGRESS_TTL_MS = 15 * 60 * 1000;
const CHAT_PROGRESS_MAX_STEPS = 60;

const chatProgressByConversation = new Map();
const activeChatJobs = new Map();

function getWorkspaceDefaults() {
  const homeDir = os.homedir();
  const desktopDir = path.join(homeDir, "Desktop");
  const workspaceRoot = process.env.EMBER_WORKSPACE_ROOT || homeDir;
  return { homeDir, desktopDir, workspaceRoot };
}

function getProtectedPaths(homeDir) {
  const platform = process.platform;
  const protectedWrite = [];
  const protectedDelete = [];
  const protectedCommandPatterns = [];

  if (platform === "win32") {
    protectedWrite.push(
      "C:\\Windows",
      "C:\\Program Files",
      "C:\\Program Files (x86)",
      "C:\\ProgramData"
    );
  } else if (platform === "darwin") {
    protectedWrite.push(
      "/System",
      "/Library",
      "/usr",
      "/bin",
      "/sbin",
      "/etc",
      "/var",
      "/Applications"
    );
  } else {
    protectedWrite.push(
      "/bin",
      "/sbin",
      "/usr",
      "/etc",
      "/var",
      "/boot",
      "/lib",
      "/lib64",
      "/opt",
      "/proc",
      "/sys",
      "/dev",
      "/run"
    );
  }

  protectedDelete.push(
    path.join(homeDir, "Desktop", "install-ember.sh"),
    process.cwd()
  );

  protectedCommandPatterns.push(
    "desktop/ember",
    "desktop/install-ember.sh",
    "~/desktop/ember",
    "~/desktop/install-ember.sh"
  );

  return { protectedWrite, protectedDelete, protectedCommandPatterns };
}

const buildPaths = (dir) => ({
  config: path.join(dir, "config.json"),
  core: path.join(dir, "core.md"),
  user: path.join(dir, "user.md"),
  soul: path.join(dir, "soul.md"),
  memory: path.join(dir, "memory.jsonl"), // legacy, kept for migration
  conversations: path.join(dir, "conversations"),
  conversationsIndex: path.join(dir, "conversations", "index.json"),
  memories: path.join(dir, "memories"),
  memoriesIndex: path.join(dir, "memories", "index.jsonl"),
  skills: path.join(dir, "skills"),
  skillsTools: path.join(dir, "skills", "tools"),
  tools: path.join(dir, "tools"),
  tasks: path.join(dir, "tasks.jsonl"),
  logs: path.join(dir, "logs"),
  agentLog: path.join(dir, "logs", "agent.log"),
});

let PATHS = buildPaths(DATA_DIR);

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

function normalizeProviderId(providerId) {
  const id = String(providerId || "").trim().toLowerCase();
  if (!id) return "";
  if (id === "codex") return OPENAI_CODEX_PROVIDER_ID;
  return id;
}

const DEFAULT_PROVIDERS = [
  {
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
  {
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
  {
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
      temperature: 1.0,
      top_p: 1.0,
      max_tokens: 16384,
    },
  },
  {
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
  {
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
  {
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
  {
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
  {
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
];

const DEFAULT_ROLE_ASSIGNMENTS = {
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneDefaultProviders() {
  return cloneJson(DEFAULT_PROVIDERS);
}

function cloneDefaultRoleAssignments() {
  return cloneJson(DEFAULT_ROLE_ASSIGNMENTS);
}

const DEFAULT_CONFIG = {
  provider: "local-qwen",
  endpoint: "http://100.124.19.71:8080/v1/chat/completions",
  model: LOCAL_QWEN_MODEL,
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.05,
  repetition_penalty: 1.05,
  max_tokens: 0,
  contextWindow: 28660,
  statelessProvider: true,
  lightweightMode: false,
  maxToolRounds: 48,
  unrestrictedShell: false,
  webSearchEnabled: true,
  toolMode: "auto",
  toolTemperature: 0.35,
  toolTopK: 8,
  toolRepetitionPenalty: 1.2,
  workspaceRoot: getWorkspaceDefaults().workspaceRoot,
  desktopDir: getWorkspaceDefaults().desktopDir,
  homeDir: getWorkspaceDefaults().homeDir,
  maxMemoryItems: 10,
  maxMemoryChars: 2000,
  contextCharBudget: 28000,
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
  providers: cloneDefaultProviders(),
  roleAssignments: cloneDefaultRoleAssignments(),
  payloadCompatDisabledParams: {},
};

const DEFAULT_CORE_PROMPT = [
  "You are Ember, a local coding assistant.",
  "Always execute tasks using tools. Never describe what you would do - do it.",
  "If a task requires multiple steps, keep calling tools until every step is complete.",
  "When a tool fails, retry with corrected arguments or explain the error.",
  "Proactively save durable memories with save_memory during the tool loop.",
  "Save stable user identity, preferences, workflow constraints, and long-lived project facts.",
  "Do not rely only on automatic post-processing when a fact is clearly worth remembering.",
].join("\n");
const DEFAULT_SOUL_MD = "You are funny, concise, and helpful.";

function upgradeLegacyConfig(parsed) {
  const next = parsed && typeof parsed === "object" ? { ...parsed } : {};
  const workspaceDefaults = getWorkspaceDefaults();

  if (!Array.isArray(next.providers) || next.providers.length === 0) {
    const providers = cloneDefaultProviders();
    const legacyProviderId = normalizeProviderId(
      typeof next.provider === "string" && next.provider.trim()
        ? next.provider.trim()
        : "legacy-primary"
    );
    const legacyEndpoint =
      typeof next.endpoint === "string" && next.endpoint.trim()
        ? next.endpoint.trim()
        : DEFAULT_CONFIG.endpoint;
    const legacyModel =
      typeof next.model === "string" && next.model.trim()
        ? next.model.trim()
        : LOCAL_QWEN_MODEL;
    const isAnthropic = /anthropic\.com/i.test(legacyEndpoint);
    const localProvider = providers.find((provider) => provider.id === "local-qwen");

    if (legacyEndpoint === DEFAULT_CONFIG.endpoint && localProvider) {
      localProvider.defaultModel = legacyModel;
      if (!localProvider.models.includes(legacyModel)) {
        localProvider.models = Array.from(new Set([legacyModel, ...localProvider.models]));
      }
      localProvider.enabled = true;
    } else {
      providers.unshift({
        id: legacyProviderId,
        name: "Primary Provider",
        type: isAnthropic ? "anthropic" : "openai-compatible",
        endpoint: legacyEndpoint,
        apiKey: "",
        apiKeyEnvVar: "",
        authType: "api-key",
        models: legacyModel ? [legacyModel] : [],
        defaultModel: legacyModel,
        maxContextWindow: Number.isFinite(next.contextWindow)
          ? next.contextWindow
          : DEFAULT_CONFIG.contextWindow,
        supportsTools: true,
        supportsStreaming: true,
        supportsBrowser: false,
        enabled: true,
        samplingDefaults: {
          temperature:
            typeof next.temperature === "number"
              ? next.temperature
              : DEFAULT_CONFIG.temperature,
          top_p:
            typeof next.top_p === "number" ? next.top_p : DEFAULT_CONFIG.top_p,
          max_tokens:
            typeof next.max_tokens === "number"
              ? next.max_tokens
              : DEFAULT_CONFIG.max_tokens,
        },
      });
    }

    const routerModel =
      typeof next?.modelRoles?.classifier === "string" && next.modelRoles.classifier.trim()
        ? next.modelRoles.classifier.trim()
        : legacyModel;
    next.providers = providers;
    next.roleAssignments = {
      default: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model:
          typeof next?.modelRoles?.assistant === "string" && next.modelRoles.assistant.trim()
            ? next.modelRoles.assistant.trim()
            : legacyModel,
      },
      planner: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model:
          typeof next?.modelRoles?.planner === "string" && next.modelRoles.planner.trim()
            ? next.modelRoles.planner.trim()
            : legacyModel,
      },
      coder: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model:
          typeof next?.modelRoles?.coder === "string" && next.modelRoles.coder.trim()
            ? next.modelRoles.coder.trim()
            : legacyModel,
      },
      auditor: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model:
          typeof next?.modelRoles?.critic === "string" && next.modelRoles.critic.trim()
            ? next.modelRoles.critic.trim()
            : legacyModel,
      },
      maintenance: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model: legacyModel,
      },
      router: {
        providerId: legacyEndpoint === DEFAULT_CONFIG.endpoint ? "local-qwen" : legacyProviderId,
        model: routerModel,
      },
    };
  }

  if (!next.roleAssignments || typeof next.roleAssignments !== "object") {
    next.roleAssignments = cloneDefaultRoleAssignments();
  } else {
    next.roleAssignments = {
      ...cloneDefaultRoleAssignments(),
      ...next.roleAssignments,
    };
  }
  next.payloadCompatDisabledParams = normalizePayloadCompatCache(
    next.payloadCompatDisabledParams
  );

  next.workspaceRoot = next.workspaceRoot || workspaceDefaults.workspaceRoot;
  next.desktopDir = next.desktopDir || workspaceDefaults.desktopDir;
  next.homeDir = workspaceDefaults.homeDir;
  return next;
}

// ── File helpers ────────────────────────────────────────────────────────────

const fileLocks = new Map();

async function withFileLock(filePath, action) {
  const current = fileLocks.get(filePath) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  fileLocks.set(filePath, current.then(() => next));
  await current;
  try {
    return await action();
  } finally {
    release();
    if (fileLocks.get(filePath) === next) {
      fileLocks.delete(filePath);
    }
  }
}

async function ensureFile(filePath, initialContent) {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await withFileLock(filePath, () =>
      writeFile(filePath, initialContent, "utf8")
    );
  }
}

async function readText(filePath, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function loadEmberProjectManifest(projectDir) {
  const targetDir = String(projectDir || "").trim();
  if (!targetDir) return null;
  try {
    const raw = await readFile(path.join(targetDir, ".ember-project.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function logEvent(event, data = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  });
  try {
    await appendFile(PATHS.agentLog, `${line}\n`, "utf8");
  } catch {
    // ignore logging errors
  }
}

function trimChatProgressStore() {
  const now = Date.now();
  for (const [conversationId, state] of chatProgressByConversation.entries()) {
    const ageMs = now - Date.parse(state?.updatedAt || "");
    if (!Number.isFinite(ageMs) || ageMs > CHAT_PROGRESS_TTL_MS) {
      chatProgressByConversation.delete(conversationId);
    }
  }
}

function updateChatProgress(conversationId, status, text, meta = {}) {
  if (!conversationId) return;
  trimChatProgressStore();
  const nowIso = new Date().toISOString();
  const prev = chatProgressByConversation.get(conversationId);
  const next = prev || {
    conversationId,
    status: "running",
    startedAt: nowIso,
    updatedAt: nowIso,
    steps: [],
  };
  if (status) {
    next.status = status;
  }
  next.updatedAt = nowIso;
  if (typeof text === "string" && text.trim()) {
    next.steps.push({
      ts: nowIso,
      text: text.trim().slice(0, 240),
      ...meta,
    });
    if (next.steps.length > CHAT_PROGRESS_MAX_STEPS) {
      next.steps = next.steps.slice(-CHAT_PROGRESS_MAX_STEPS);
    }
  }
  chatProgressByConversation.set(conversationId, next);
}

function beginChatProgress(conversationId, text, meta = {}) {
  if (!conversationId) return;
  trimChatProgressStore();
  const nowIso = new Date().toISOString();
  const next = {
    conversationId,
    status: "running",
    startedAt: nowIso,
    updatedAt: nowIso,
    steps: [],
  };
  chatProgressByConversation.set(conversationId, next);
  updateChatProgress(conversationId, "running", text, meta);
}

function createSyntheticJsonRequest(body) {
  const raw = Buffer.from(JSON.stringify(body || {}), "utf8");
  const stream = Readable.from([raw]);
  stream.headers = { "content-type": "application/json" };
  return stream;
}

function createNullResponse() {
  return {
    writeHead() {},
    end() {},
  };
}

function generateId(prefix) {
  const ts = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  return `${prefix}_${ts}_${rand}`;
}

// ── Data layout & migration ─────────────────────────────────────────────────

async function ensureDataLayout() {
  try {
    await ensureDataLayoutAtCurrentPath();
  } catch (error) {
    const denied =
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM");
    if (!denied) throw error;
    DATA_DIR = path.join(process.cwd(), ".ember-agent");
    PATHS = buildPaths(DATA_DIR);
    await ensureDataLayoutAtCurrentPath();
  }
}

async function ensureDataLayoutAtCurrentPath() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PATHS.skills, { recursive: true });
  await mkdir(PATHS.skillsTools, { recursive: true });
  await mkdir(PATHS.tools, { recursive: true });
  await mkdir(PATHS.conversations, { recursive: true });
  await mkdir(PATHS.memories, { recursive: true });
  await mkdir(PATHS.logs, { recursive: true });

  await ensureFile(PATHS.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await ensureFile(PATHS.core, `${DEFAULT_CORE_PROMPT}\n`);
  await ensureFile(PATHS.user, "# user.md\n");
  await ensureFile(PATHS.soul, `${DEFAULT_SOUL_MD}\n`);
  await ensureFile(PATHS.agentLog, "");
  await ensureFile(PATHS.tasks, "");
  await ensureFile(
    PATHS.conversationsIndex,
    '{"conversations":[],"activeId":null}\n'
  );
  await ensureFile(PATHS.memoriesIndex, "");

  const soulCurrent = (await readText(PATHS.soul, "")).trim().toLowerCase();
  if (!soulCurrent || soulCurrent === "# soul.md") {
    await writeFile(PATHS.soul, `${DEFAULT_SOUL_MD}\n`, "utf8");
  }

  const coreCurrent = (await readText(PATHS.core, "")).trim().toLowerCase();
  if (!coreCurrent || coreCurrent === "# core.md") {
    await writeFile(PATHS.core, `${DEFAULT_CORE_PROMPT}\n`, "utf8");
  }

  await migrateOldMemory();
}

async function migrateOldMemory() {
  const oldMemory = await readText(PATHS.memory, "");
  if (!oldMemory.trim()) return;

  const manifest = await loadManifest();
  if (manifest.conversations.length > 0) return; // already migrated

  const id = generateId("conv");
  const now = new Date().toISOString();
  const convPath = conversationFilePath(id);
  await writeFile(convPath, oldMemory, "utf8");

  const count = oldMemory.trim().split("\n").length;
  manifest.conversations.unshift({
    id,
    title: "Imported conversation",
    createdAt: now,
    updatedAt: now,
    messageCount: count,
  });
  manifest.activeId = id;
  await saveManifest(manifest);

  await rename(PATHS.memory, `${PATHS.memory}.bak`);
  process.stdout.write(
    `[agent] migrated memory.jsonl → conversations/${id}.jsonl (${count} records)\n`
  );
}

// ── App config ──────────────────────────────────────────────────────────────

function normalizeProviders(providers) {
  const normalizeSecret = (value) =>
    typeof value === "string" ? value.replace(/\s+/g, "") : value;
  const source = Array.isArray(providers) && providers.length > 0
    ? providers
    : cloneDefaultProviders();
  const defaultsById = new Map(
    cloneDefaultProviders().map((provider) => [provider.id, provider])
  );
  const seenIds = new Set();
  return source
    .filter((provider) => provider && typeof provider === "object" && provider.id)
    .map((provider) => {
      const normalizedId = normalizeProviderId(provider.id);
      if (!normalizedId || seenIds.has(normalizedId)) {
        return null;
      }
      seenIds.add(normalizedId);
      const fallback = defaultsById.get(normalizedId) || {};
      const merged = {
        ...fallback,
        ...provider,
        id: normalizedId,
        samplingDefaults: {
          ...(fallback.samplingDefaults || {}),
          ...(provider.samplingDefaults || {}),
        },
      };
      if (fallback && fallback.id) {
        merged.type = fallback.type || merged.type;
        merged.endpoint = fallback.endpoint || merged.endpoint;
        if (fallback.modelsEndpoint) {
          merged.modelsEndpoint = fallback.modelsEndpoint;
        }
        if (Array.isArray(fallback.models) && fallback.models.length > 0) {
          const customModels = Array.isArray(provider.models)
            ? provider.models.map((model) => String(model).trim()).filter(Boolean)
            : [];
          merged.models = Array.from(new Set([...fallback.models, ...customModels]));
        }
        if (
          (!merged.defaultModel || !String(merged.defaultModel).trim()) &&
          fallback.defaultModel
        ) {
          merged.defaultModel = fallback.defaultModel;
        }
      }
      if (typeof merged.apiKey === "string") {
        merged.apiKey = normalizeSecret(merged.apiKey);
      }
      if (typeof merged.oauthRefreshToken === "string") {
        merged.oauthRefreshToken = normalizeSecret(merged.oauthRefreshToken);
      }
      if (typeof merged.oauthIdToken === "string") {
        merged.oauthIdToken = normalizeSecret(merged.oauthIdToken);
      }
      merged.models = Array.isArray(merged.models)
        ? Array.from(new Set(merged.models.map((model) => String(model).trim()).filter(Boolean)))
        : [];
      if (!merged.defaultModel && merged.models[0]) {
        merged.defaultModel = merged.models[0];
      }
      merged.enabled = merged.enabled !== false;
      return merged;
    })
    .filter(Boolean);
}

function buildLegacyModelRoles(roleAssignments = {}, currentRoles = {}) {
  return {
    assistant:
      roleAssignments?.default?.model ||
      currentRoles?.assistant ||
      DEFAULT_CONFIG.modelRoles.assistant,
    planner:
      roleAssignments?.planner?.model ||
      currentRoles?.planner ||
      DEFAULT_CONFIG.modelRoles.planner,
    coder:
      roleAssignments?.coder?.model ||
      currentRoles?.coder ||
      DEFAULT_CONFIG.modelRoles.coder,
    critic:
      roleAssignments?.auditor?.model ||
      currentRoles?.critic ||
      DEFAULT_CONFIG.modelRoles.critic,
    classifier:
      roleAssignments?.router?.model ||
      currentRoles?.classifier ||
      DEFAULT_CONFIG.modelRoles.classifier,
  };
}

function normalizeRoleAssignments(assignments, providers, legacyRoles = {}) {
  const providerMap = new Map(
    normalizeProviders(providers).map((provider) => [provider.id, provider])
  );
  const defaults = cloneDefaultRoleAssignments();
  const merged = {
    ...defaults,
    ...(assignments || {}),
  };
  for (const roleId of Object.keys(defaults)) {
    const current = merged[roleId] || defaults[roleId];
    const normalizedProviderId = normalizeProviderId(current.providerId);
    const providerId = providerMap.has(normalizedProviderId)
      ? normalizedProviderId
      : defaults[roleId].providerId;
    const provider = providerMap.get(providerId) || providerMap.get(defaults[roleId].providerId);
    const fallbackModel =
      legacyRoles[
        roleId === "default"
          ? "assistant"
          : roleId === "auditor"
            ? "critic"
            : roleId === "router"
              ? "classifier"
              : roleId
      ];
    merged[roleId] = {
      providerId,
      model:
        current.model ||
        fallbackModel ||
        provider?.defaultModel ||
        defaults[roleId].model,
    };
  }
  return merged;
}

function serializePersistedConfig(config) {
  const providers = normalizeProviders(config.providers);
  const roleAssignments = normalizeRoleAssignments(
    config.roleAssignments,
    providers,
    config.modelRoles
  );
  const legacyModelRoles = buildLegacyModelRoles(roleAssignments, config.modelRoles);
  const defaultAssignment = roleAssignments.default;
  const defaultProvider = providers.find((provider) => provider.id === defaultAssignment.providerId);

  return {
    provider: defaultAssignment.providerId,
    endpoint: defaultProvider?.endpoint || config.endpoint,
    model: defaultAssignment.model || config.model,
    temperature: config.temperature,
    top_p: config.top_p,
    top_k: config.top_k,
    min_p: config.min_p,
    repetition_penalty: config.repetition_penalty,
    max_tokens: config.max_tokens,
    contextWindow: config.contextWindow,
    statelessProvider: Boolean(config.statelessProvider),
    unrestrictedShell: Boolean(config.unrestrictedShell),
    webSearchEnabled: Boolean(config.webSearchEnabled),
    toolMode: config.toolMode || DEFAULT_CONFIG.toolMode,
    toolTemperature: config.toolTemperature,
    toolTopK: config.toolTopK,
    toolRepetitionPenalty: config.toolRepetitionPenalty,
    maxMemoryItems: config.maxMemoryItems,
    maxMemoryChars: config.maxMemoryChars,
    contextCharBudget: config.contextCharBudget,
    modelRoles: legacyModelRoles,
    lightweightMode: Boolean(config.lightweightMode),
    maxToolRounds: Number.isFinite(config.maxToolRounds)
      ? config.maxToolRounds
      : DEFAULT_CONFIG.maxToolRounds,
    workspaceRoot: config.workspaceRoot,
    desktopDir: config.desktopDir,
    homeDir: config.homeDir,
    githubUsername: config.githubUsername || "",
    githubEmail: config.githubEmail || "",
    githubToken: config.githubToken || "",
    providers,
    roleAssignments,
    payloadCompatDisabledParams: normalizePayloadCompatCache(
      config.payloadCompatDisabledParams
    ),
  };
}

async function loadConfig(overrides) {
  const raw = await readText(PATHS.config, "{}");
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  parsed = upgradeLegacyConfig(parsed);
  const workspaceDefaults = getWorkspaceDefaults();
  return {
    ...DEFAULT_CONFIG,
    ...workspaceDefaults,
    ...parsed,
    providers: normalizeProviders(parsed.providers),
    roleAssignments: normalizeRoleAssignments(
      parsed.roleAssignments,
      parsed.providers,
      parsed.modelRoles
    ),
    modelRoles: {
      ...DEFAULT_CONFIG.modelRoles,
      ...(parsed.modelRoles || {}),
    },
    payloadCompatDisabledParams: normalizePayloadCompatCache(
      parsed.payloadCompatDisabledParams
    ),
    ...(overrides || {}),
  };
}

async function loadAgentConfigForUi() {
  const [config, corePrompt, userMd, soulMd] = await Promise.all([
    loadConfig(),
    readText(PATHS.core, DEFAULT_CORE_PROMPT),
    readText(PATHS.user, ""),
    readText(PATHS.soul, ""),
  ]);
  const normalizedSoulMd =
    !soulMd.trim() || soulMd.trim().toLowerCase() === "# soul.md"
      ? DEFAULT_SOUL_MD
      : soulMd;
  return { ...config, corePrompt, userMd, soulMd: normalizedSoulMd };
}

async function ensureWorkspaceConfig() {
  const current = await loadConfig();
  const workspaceDefaults = getWorkspaceDefaults();
  const nextConfig = {
    ...current,
    workspaceRoot: current.workspaceRoot || workspaceDefaults.workspaceRoot,
    desktopDir: current.desktopDir || workspaceDefaults.desktopDir,
    homeDir: workspaceDefaults.homeDir,
  };

  const shouldWrite =
    !current.workspaceRoot ||
    !current.desktopDir ||
    !current.homeDir ||
    current.homeDir !== workspaceDefaults.homeDir;

  if (!shouldWrite) return;

  await writeFile(
    PATHS.config,
    `${JSON.stringify(serializePersistedConfig(nextConfig), null, 2)}\n`,
    "utf8"
  );
}

async function saveAgentConfigFromUi(input) {
  const current = await loadConfig();
  const workspaceDefaults = getWorkspaceDefaults();
  const nextConfig = {
    ...current,
    ...input,
    homeDir: workspaceDefaults.homeDir,
    modelRoles: { ...current.modelRoles, ...(input?.modelRoles || {}) },
    providers: normalizeProviders(input?.providers || current.providers),
    roleAssignments: normalizeRoleAssignments(
      input?.roleAssignments || current.roleAssignments,
      input?.providers || current.providers,
      { ...current.modelRoles, ...(input?.modelRoles || {}) }
    ),
  };

  await writeFile(
    PATHS.config,
    `${JSON.stringify(serializePersistedConfig(nextConfig), null, 2)}\n`,
    "utf8"
  );

  try {
    await configureGitHubAuth({
      username: nextConfig.githubUsername,
      email: nextConfig.githubEmail,
      token: nextConfig.githubToken,
    });
  } catch (error) {
    await logEvent("github_config_error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  if (typeof input?.corePrompt === "string") {
    await writeFile(PATHS.core, `${input.corePrompt}\n`, "utf8");
  }
  if (typeof input?.userMd === "string") {
    await writeFile(PATHS.user, input.userMd, "utf8");
  }
  if (typeof input?.soulMd === "string") {
    await writeFile(PATHS.soul, input.soulMd, "utf8");
  }
}

async function configureGitHubAuth({
  username,
  email,
  token,
}) {
  const user = typeof username === "string" ? username.trim() : "";
  const mail = typeof email === "string" ? email.trim() : "";
  const pat = typeof token === "string" ? token.trim() : "";
  if (!user && !mail && !pat) return;

  if (user) {
    await execFileAsync("git", ["config", "--global", "user.name", user]);
  }
  if (mail) {
    await execFileAsync("git", ["config", "--global", "user.email", mail]);
  }

  if (pat) {
    await execFileAsync("git", ["config", "--global", "credential.helper", "store"]);
    const safeUser = encodeURIComponent(user || "oauth");
    const safeToken = encodeURIComponent(pat);
    const credentialsPath = path.join(os.homedir(), ".git-credentials");
    let existing = "";
    try {
      existing = await readFile(credentialsPath, "utf8");
    } catch {
      existing = "";
    }
    const filtered = existing
      .split("\n")
      .filter((line) => line.trim() && !line.includes("github.com"))
      .join("\n");
    const entry = `https://${safeUser}:${safeToken}@github.com`;
    const content = filtered ? `${filtered}\n${entry}\n` : `${entry}\n`;
    await writeFile(credentialsPath, content, { encoding: "utf8", mode: 0o600 });
  }
}

// ── Conversations ───────────────────────────────────────────────────────────

async function loadManifest() {
  const raw = await readText(
    PATHS.conversationsIndex,
    '{"conversations":[],"activeId":null}'
  );
  try {
    return JSON.parse(raw);
  } catch {
    return { conversations: [], activeId: null };
  }
}

async function saveManifest(manifest) {
  await withFileLock(PATHS.conversationsIndex, () =>
    writeFile(
      PATHS.conversationsIndex,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    )
  );
}

function conversationFilePath(id) {
  // Sanitize id to prevent path traversal
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(PATHS.conversations, `${safe}.jsonl`);
}

function conversationSummaryPath(id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(PATHS.conversations, `${safe}.summary.json`);
}

async function loadConversationMessages(id, limit) {
  const raw = await readText(conversationFilePath(id), "");
  if (!raw.trim()) return [];
  const parsed = raw
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return limit ? parsed.slice(-limit) : parsed;
}

async function loadConversationSummary(id) {
  const raw = await readText(conversationSummaryPath(id), "");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveConversationSummary(id, summary) {
  const payload = summary ? JSON.stringify(summary, null, 2) : "";
  await withFileLock(conversationSummaryPath(id), () =>
    writeFile(conversationSummaryPath(id), payload ? `${payload}\n` : "", "utf8")
  );
}

async function appendToConversation(id, role, content, extra = {}) {
  const record = { ts: new Date().toISOString(), role, content, ...extra };
  const filePath = conversationFilePath(id);
  await withFileLock(filePath, () =>
    appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8")
  );
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickFiniteNumber(...values) {
  for (const value of values) {
    const next = toFiniteNumber(value);
    if (next !== null) return next;
  }
  return null;
}

function nanosToMillis(value) {
  const next = toFiniteNumber(value);
  return next === null ? null : next / 1_000_000;
}

function estimateTokens(text) {
  const input = typeof text === "string" ? text.trim() : "";
  if (!input) return 0;
  return Math.max(1, Math.ceil(input.length / 4));
}

function buildAssistantMeta({
  finalResponse,
  activeModel,
  configuredModel,
  providerId,
  providerName,
  roleId,
  contextMessages,
  promptTokenEstimate,
  promptMessageCount,
  elapsedMs,
  llmCalls,
  toolTrace,
}) {
  const response = finalResponse && typeof finalResponse === "object" ? finalResponse : {};
  const usage = response.usage && typeof response.usage === "object" ? response.usage : {};
  const timings =
    response.timings && typeof response.timings === "object" ? response.timings : {};

  const promptTokens = pickFiniteNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    response.prompt_eval_count,
    response.prompt_tokens,
    timings.prompt_n
  );
  const completionTokens = pickFiniteNumber(
    usage.completion_tokens,
    usage.output_tokens,
    response.eval_count,
    response.completion_tokens,
    response.generated_tokens,
    timings.predicted_n
  );
  const totalTokens = pickFiniteNumber(
    usage.total_tokens,
    response.total_tokens,
    promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null
  );
  const promptMs = pickFiniteNumber(
    timings.prompt_ms,
    nanosToMillis(response.prompt_eval_duration),
    nanosToMillis(response.prompt_duration)
  );
  const completionMs = pickFiniteNumber(
    timings.predicted_ms,
    nanosToMillis(response.eval_duration),
    nanosToMillis(response.completion_duration)
  );
  const totalMs = pickFiniteNumber(
    timings.total_ms,
    nanosToMillis(response.total_duration),
    elapsedMs
  );
  const tokensPerSecond = pickFiniteNumber(
    timings.predicted_per_second,
    timings.tokens_per_second,
    completionTokens !== null && completionMs
      ? completionTokens / (completionMs / 1000)
      : null,
    completionTokens !== null && totalMs
      ? completionTokens / (totalMs / 1000)
      : null
  );

  const resolvedModel = String(response.model || activeModel || configuredModel || "").trim();
  const preferredModel = String(activeModel || configuredModel || response.model || "").trim();

  return {
    role: roleId || null,
    providerId: providerId || null,
    providerName: providerName || null,
    model: preferredModel || resolvedModel || "Configured model",
    providerModel:
      resolvedModel && resolvedModel !== preferredModel ? resolvedModel : null,
    contextTokens: Math.round(promptTokens ?? promptTokenEstimate),
    contextMessages: promptMessageCount,
    promptTokens: promptTokens !== null ? Math.round(promptTokens) : null,
    completionTokens:
      completionTokens !== null ? Math.round(completionTokens) : null,
    totalTokens: totalTokens !== null ? Math.round(totalTokens) : null,
    elapsedMs: totalMs !== null ? Number(totalMs.toFixed(1)) : null,
    promptMs: promptMs !== null ? Number(promptMs.toFixed(1)) : null,
    completionMs: completionMs !== null ? Number(completionMs.toFixed(1)) : null,
    tokensPerSecond:
      tokensPerSecond !== null ? Number(tokensPerSecond.toFixed(2)) : null,
    llmCalls: Math.max(1, Math.round(toFiniteNumber(llmCalls) || 1)),
    toolsUsed: Array.isArray(toolTrace)
      ? [...new Set(toolTrace.map((entry) => entry?.name).filter(Boolean))]
      : [],
    toolTrace: Array.isArray(toolTrace) ? toolTrace : [],
  };
}

function buildToolTrace(messages) {
  const traces = [];
  const toolCallsById = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const id = toolCall?.id;
        const name = toolCall?.function?.name;
        if (!id || !name) continue;
        toolCallsById.set(id, { name });
      }
      continue;
    }
    if (message?.role === "tool" && message?.tool_call_id) {
      const match = toolCallsById.get(message.tool_call_id);
      if (!match) continue;
      let parsed = {};
      try {
        parsed = JSON.parse(message.content || "{}");
      } catch {
        parsed = {};
      }
      traces.push({
        name: match.name,
        status:
          parsed?.error ||
          parsed?.ok === false ||
          parsed?.timedOut === true ||
          (parsed?.exitCode !== undefined && parsed.exitCode !== 0)
            ? "error"
            : "done",
      });
    }
  }
  return traces;
}

async function createConversation(title) {
  const id = generateId("conv");
  const now = new Date().toISOString();
  const filePath = conversationFilePath(id);
  await withFileLock(filePath, () => writeFile(filePath, "", "utf8"));
  const manifest = await loadManifest();
  const conv = {
    id,
    title: title || "New conversation",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  manifest.conversations.unshift(conv);
  manifest.activeId = id;
  await saveManifest(manifest);
  return conv;
}

async function deleteConversation(id) {
  const manifest = await loadManifest();
  manifest.conversations = manifest.conversations.filter((c) => c.id !== id);
  if (manifest.activeId === id) {
    manifest.activeId = manifest.conversations[0]?.id || null;
  }
  await saveManifest(manifest);
  try {
    await unlink(conversationFilePath(id));
  } catch {}
}

async function deleteAllConversations() {
  const manifest = await loadManifest();
  const ids = manifest.conversations.map((c) => c.id);
  for (const id of ids) {
    try {
      await unlink(conversationFilePath(id));
    } catch {}
  }
  try {
    const entries = await readdir(PATHS.conversations, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) =>
          unlink(path.join(PATHS.conversations, entry.name)).catch(() => {})
        )
    );
  } catch {}
  await saveManifest({ conversations: [], activeId: null });
}

// ── Memories ────────────────────────────────────────────────────────────────

async function loadAllMemories() {
  const raw = await readText(PATHS.memoriesIndex, "");
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        if (!Array.isArray(parsed.embedding)) {
          parsed.embedding = buildEmbedding(parsed.content || "");
        }
        if (typeof parsed.confidence !== "number") {
          parsed.confidence = 1;
        }
        if (typeof parsed.approved !== "boolean") {
          parsed.approved = parsed.confirmed !== false;
        }
        return parsed;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function rehashEmbeddingsIfNeeded() {
  if (EMBEDDINGS_ENDPOINT) return;
  const all = await loadAllMemories();
  if (all.length === 0) return;
  const targetDim = buildEmbedding("x").length;
  let changed = false;
  const updated = all.map((mem) => {
    if (!mem || typeof mem.content !== "string") return mem;
    const embedding = Array.isArray(mem.embedding) ? mem.embedding : null;
    if (!embedding || embedding.length !== targetDim) {
      changed = true;
      return { ...mem, embedding: buildEmbedding(mem.content) };
    }
    return mem;
  });
  if (changed) {
    await updateMemories(updated);
  }
}

// ── Tasks ───────────────────────────────────────────────────────────────────

async function loadTasks() {
  const raw = await readText(PATHS.tasks, "");
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function writeTasks(tasks) {
  const content = tasks.length
    ? tasks.map((t) => JSON.stringify(t)).join("\n") + "\n"
    : "";
  await withFileLock(PATHS.tasks, () => writeFile(PATHS.tasks, content, "utf8"));
}

function normalizeStep(step) {
  if (typeof step !== "string") return "";
  const text = step.trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.slice(0, 200);
}

async function createTask({ title, steps = [] }) {
  const taskId = generateId("task");
  const now = new Date().toISOString();
  const normalizedSteps = Array.isArray(steps)
    ? steps.map(normalizeStep).filter(Boolean)
    : [];
  const record = {
    id: taskId,
    title: typeof title === "string" && title.trim() ? title.trim() : "Task",
    steps: normalizedSteps.map((content, index) => ({
      id: `${taskId}_step_${index + 1}`,
      content,
      status: "todo",
    })),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const all = await loadTasks();
  all.push(record);
  await writeTasks(all);
  return record;
}

async function addTaskSteps(taskId, steps) {
  const all = await loadTasks();
  const task = all.find((t) => t.id === taskId);
  if (!task) return { error: "Task not found" };
  const normalized = Array.isArray(steps)
    ? steps.map(normalizeStep).filter(Boolean)
    : [];
  const start = task.steps.length;
  for (let i = 0; i < normalized.length; i += 1) {
    task.steps.push({
      id: `${taskId}_step_${start + i + 1}`,
      content: normalized[i],
      status: "todo",
    });
  }
  task.updatedAt = new Date().toISOString();
  await writeTasks(all);
  return task;
}

async function getNextStep(taskId) {
  const all = await loadTasks();
  const task = all.find((t) => t.id === taskId);
  if (!task) return { error: "Task not found" };
  const next = task.steps.find((s) => s.status === "todo") || null;
  if (!next) {
    task.status = "done";
    task.updatedAt = new Date().toISOString();
    await writeTasks(all);
  }
  return { task, next };
}

async function completeStep(taskId, stepId, note) {
  const all = await loadTasks();
  const task = all.find((t) => t.id === taskId);
  if (!task) return { error: "Task not found" };
  const step = task.steps.find((s) => s.id === stepId);
  if (!step) return { error: "Step not found" };
  step.status = "done";
  if (note && typeof note === "string") {
    step.note = note.trim().slice(0, 300);
  }
  task.updatedAt = new Date().toISOString();
  if (!task.steps.some((s) => s.status === "todo")) {
    task.status = "done";
  }
  await writeTasks(all);
  return { task, step };
}

async function getTask(taskId) {
  const all = await loadTasks();
  const task = all.find((t) => t.id === taskId);
  return task || null;
}

async function listTasks() {
  const all = await loadTasks();
  return all.slice(-50);
}

async function searchMemories(query, tags) {
  const all = await loadAllMemories();
  const filtered =
    tags && tags.length > 0
      ? all.filter((m) => tags.some((t) => m.tags?.includes(t)))
      : all;
  const limit = inferRelevantMemoryLimit(filtered, query, 10, 15, {
    minScore: 0,
    referenceMaxAgeDays: 3650,
    maxAgeDays: 3650,
  });
  return selectMemoriesWithFallback(filtered, query, limit, {
    maxPinned: 3,
    maxAgeDays: 3650,
    referenceMaxAgeDays: 3650,
    minScore: 0,
  });
}

function normalizeMemoryComparable(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryTextSimilarity(a, b) {
  const left = normalizeMemoryComparable(a);
  const right = normalizeMemoryComparable(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const shorter = Math.min(left.length, right.length);
    const longer = Math.max(left.length, right.length);
    return shorter / Math.max(longer, 1);
  }
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  return intersection / union;
}

function cosineSimilarityFromVectors(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const GRAPH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "user",
  "uses",
  "using",
  "project",
  "memory",
  "agent",
  "their",
  "they",
  "have",
  "has",
  "was",
  "are",
  "but",
  "not",
  "into",
  "only",
  "when",
  "what",
  "which",
  "will",
  "would",
  "could",
  "should",
  "about",
]);

function getGraphTokens(text) {
  const tokens = normalizeMemoryComparable(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !GRAPH_STOPWORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 8);
}

function getGraphTokenOverlap(leftText, rightText) {
  const leftTokens = getGraphTokens(leftText);
  const rightTokens = getGraphTokens(rightText);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return { score: 0, sharedCount: 0 };
  }
  const rightSet = new Set(rightTokens);
  let sharedCount = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) sharedCount += 1;
  }
  return {
    score: sharedCount / Math.max(1, Math.min(leftTokens.length, rightTokens.length)),
    sharedCount,
  };
}

async function createMemory(content, tags, source, meta = {}) {
  const normalized = typeof content === "string" ? content.trim() : "";
  if (!normalized) {
    return { id: null, duplicate: false, saved: false };
  }

  const existing = await loadAllMemories();
  const recent = existing.slice(-400);
  const normalizedLower = normalized.toLowerCase();
  const duplicate = existing.find(
    (m) =>
      typeof m.content === "string" &&
      m.content.trim().toLowerCase() === normalizedLower
  );
  const similarDuplicate =
    duplicate ||
    recent.find((m) => {
      if (typeof m?.content !== "string") return false;
      return memoryTextSimilarity(m.content, normalized) >= 0.92;
    });
  if (similarDuplicate) {
    const mergedTags = Array.from(
      new Set([...(similarDuplicate.tags || []), ...((Array.isArray(tags) ? tags : []).map(String))])
    );
    const shouldPromoteApproved =
      similarDuplicate.approved === false && meta.approved !== false;
    const shouldPromoteConfirmed =
      similarDuplicate.confirmed === false && meta.confirmed === true;
    if (
      mergedTags.length !== (similarDuplicate.tags || []).length ||
      shouldPromoteApproved ||
      shouldPromoteConfirmed
    ) {
      await updateMemoryById(similarDuplicate.id, {
        content: similarDuplicate.content,
        tags: mergedTags,
        type: meta.type || similarDuplicate.type,
        approved: shouldPromoteApproved ? true : similarDuplicate.approved,
        confirmed: shouldPromoteConfirmed ? true : similarDuplicate.confirmed,
      });
    }
    return { id: similarDuplicate.id, duplicate: true, saved: false };
  }

  const normalizedTags = Array.isArray(tags)
    ? tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const allowedTypes = new Set([
    "identity",
    "preference",
    "project",
    "workflow",
    "reference",
    "cluster",
  ]);
  const typeFromTags = normalizedTags.find((tag) => allowedTypes.has(tag));
  const inferredTypeRaw = meta.type ? String(meta.type).trim() : typeFromTags;
  const inferredType = allowedTypes.has(inferredTypeRaw || "")
    ? inferredTypeRaw
    : "reference";
  const confidenceRaw =
    typeof meta.confidence === "number" ? meta.confidence : 1;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  const confirmed =
    typeof meta.confirmed === "boolean" ? meta.confirmed : true;
  const approved =
    typeof meta.approved === "boolean" ? meta.approved : true;

  const record = {
    id: generateId("mem"),
    ts: new Date().toISOString(),
    content: normalized,
    tags: normalizedTags,
    type: inferredType,
    confirmed,
    confidence,
    approved,
    embedding: await embedText(normalized),
    useCount: 0,
    lastUsed: null,
    source: source || null,
  };
  await withFileLock(PATHS.memoriesIndex, () =>
    appendFile(PATHS.memoriesIndex, `${JSON.stringify(record)}\n`, "utf8")
  );
  return { ...record, saved: true, duplicate: false };
}

async function deleteMemory(targetId) {
  const all = await loadAllMemories();
  const filtered = all.filter((m) => m.id !== targetId);
  if (filtered.length === all.length) {
    return { deleted: false };
  }
  const content = filtered.length
    ? filtered.map((m) => JSON.stringify(m)).join("\n") + "\n"
    : "";
  await withFileLock(PATHS.memoriesIndex, () =>
    writeFile(PATHS.memoriesIndex, content, "utf8")
  );
  return { deleted: true };
}

async function deleteAllMemories() {
  await withFileLock(PATHS.memoriesIndex, () =>
    writeFile(PATHS.memoriesIndex, "", "utf8")
  );
}

async function updateMemories(updated) {
  const content = updated.length
    ? updated.map((m) => JSON.stringify(m)).join("\n") + "\n"
    : "";
  await withFileLock(PATHS.memoriesIndex, () =>
    writeFile(PATHS.memoriesIndex, content, "utf8")
  );
}

async function updateMemoryById(id, updates) {
  const all = await loadAllMemories();
  let found = false;
  const next = await Promise.all(
    all.map(async (mem) => {
      if (mem.id !== id) return mem;
      found = true;
      const nextContent =
        typeof updates.content === "string" ? updates.content : mem.content;
      return {
        ...mem,
        content: nextContent,
        tags: Array.isArray(updates.tags) ? updates.tags : mem.tags,
        type: typeof updates.type === "string" ? updates.type : mem.type,
        confirmed:
          typeof updates.confirmed === "boolean"
            ? updates.confirmed
            : mem.confirmed,
        approved:
          typeof updates.approved === "boolean"
            ? updates.approved
            : mem.approved,
        embedding:
          typeof updates.content === "string"
            ? await embedText(nextContent)
            : mem.embedding,
      };
    })
  );
  if (!found) return { updated: false, error: "Memory not found" };
  await updateMemories(next);
  return { updated: true };
}

async function consolidateMemoryStore() {
  const all = await loadAllMemories();
  const isSummary = (mem) =>
    mem?.type === "cluster" ||
    (Array.isArray(mem?.tags) && mem.tags.includes("summary"));
  const usable = all.filter((mem) => !isSummary(mem));
  const excluded = all.filter((mem) => isSummary(mem));
  const threshold = EMBEDDINGS_ENDPOINT ? 0.92 : 0.85;
  const { updated, merged } = consolidateMemories(usable, threshold);
  if (merged.length > 0) {
    await updateMemories([...updated, ...excluded]);
  }
}

function decayConfidence(mem) {
  if (!mem?.ts || typeof mem.confidence !== "number") return mem;
  if (Array.isArray(mem?.tags) && mem.tags.includes("pin")) return mem;
  const type = typeof mem?.type === "string" ? mem.type : "";
  if (type === "identity") return mem;
  const now = Date.now();
  const created = Date.parse(mem.ts);
  if (!Number.isFinite(created)) return mem;
  const ageDays = (now - created) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return mem;
  const halfLifeDays =
    type === "preference"
      ? 365
      : type === "workflow"
        ? 180
        : type === "project"
          ? 90
          : type === "reference"
            ? 60
            : 180;
  const decay = Math.exp(-Math.log(2) * ageDays / halfLifeDays);
  const nextConfidence = Math.max(0.1, mem.confidence * decay);
  if (Math.abs(nextConfidence - mem.confidence) < 0.01) return mem;
  return { ...mem, confidence: Number(nextConfidence.toFixed(3)) };
}

async function decayMemories() {
  const all = await loadAllMemories();
  let changed = false;
  const updated = all.map((mem) => {
    const next = decayConfidence(mem);
    if (next !== mem) changed = true;
    return next;
  });
  if (changed) {
    await updateMemories(updated);
  }
}

function memoryKeepScore(mem, now = Date.now()) {
  if (!mem) return -Infinity;
  if (Array.isArray(mem.tags) && mem.tags.includes("pin")) return 1e6;
  const type = typeof mem.type === "string" ? mem.type : "";
  if (type === "identity") return 1e5;
  const typeWeight =
    type === "preference"
      ? 8
      : type === "workflow"
        ? 7
        : type === "project"
          ? 6
          : type === "reference"
            ? 5
            : 4;
  const confidence = typeof mem.confidence === "number" ? mem.confidence : 1;
  const useCount = typeof mem.useCount === "number" ? mem.useCount : 0;
  const last = mem.lastUsed || mem.ts;
  const ageMs = last ? now - Date.parse(last) : 0;
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86_400_000 : 0;
  const recency = Math.max(0, 6 - ageDays / 30);
  return confidence * 6 + Math.min(6, Math.log1p(useCount)) + typeWeight + recency;
}

async function compressOldMemories(maxKeep = 200) {
  const all = await loadAllMemories();
  const isSummary = (mem) =>
    mem?.type === "cluster" ||
    (Array.isArray(mem?.tags) && mem.tags.includes("summary"));
  const real = all.filter((mem) => !isSummary(mem));
  if (real.length <= maxKeep) return;
  const now = Date.now();
  const pinnedOrIdentity = (mem) =>
    (Array.isArray(mem?.tags) && mem.tags.includes("pin")) || mem?.type === "identity";
  const candidates = real.filter((mem) => !pinnedOrIdentity(mem));
  const dropCount = Math.max(0, real.length - maxKeep);
  if (dropCount === 0 || candidates.length === 0) return;
  const toDrop = candidates
    .slice()
    .sort((a, b) => memoryKeepScore(a, now) - memoryKeepScore(b, now))
    .slice(0, dropCount)
    .map((m) => m.id);
  if (toDrop.length === 0) return;
  const dropSet = new Set(toDrop);
  const kept = all.filter((mem) => !dropSet.has(mem.id));
  await updateMemories(kept);
}

function buildSummaryPrompt(existingSummary, messages) {
  const lines = [];
  let totalChars = 0;
  for (const msg of messages) {
    if (!msg || typeof msg.content !== "string") continue;
    const role = msg.role || "user";
    const trimmed = msg.content.trim();
    if (!trimmed) continue;
    const line = `${role}: ${trimmed.slice(0, 300)}`;
    if (totalChars + line.length > SUMMARY_MAX_INPUT_CHARS) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  const existing = existingSummary
    ? `Previous summary: ${existingSummary}\n\n`
    : "";

  return (
    `${existing}Summarize this conversation in 3-5 bullet points. ` +
    "Keep only facts, decisions, and unfinished tasks. Max 500 chars total.\n\n" +
    lines.join("\n")
  );
}

async function summarizeConversationHistory(config, existingSummary, messages) {
  if (!Array.isArray(messages) || messages.length < SUMMARY_MIN_MESSAGES) {
    return existingSummary || "";
  }
  const prompt = buildSummaryPrompt(existingSummary, messages);
  const payload = {
    messages: [
      {
        role: "system",
        content: "You compress conversations into short working summaries.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    top_p: 0.6,
    stream: false,
  };
  const providerRegistry = buildProviderRegistry(config);
  const roleExecution = resolveRoleExecution(
    config,
    providerRegistry,
    "maintenance"
  );
  const activeModel = roleExecution?.assignment?.model || config?.model;
  if (activeModel) payload.model = activeModel;

  try {
    const data = await callRoleProviderWithCompat(providerRegistry, roleExecution, payload, {
      compatConfig: config,
      timeout: 120000,
    });
    const summary =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.response ||
      "";
    return summary.slice(0, SUMMARY_MAX_OUTPUT_CHARS);
  } catch {
    return existingSummary || "";
  }
}

async function pruneMemorySummaries() {
  const all = await loadAllMemories();
  if (all.length === 0) return;
  const isSummary = (mem) =>
    (Array.isArray(mem?.tags) && mem.tags.includes("summary")) ||
    mem?.source?.kind === "auto_summary";
  const summaries = all.filter(isSummary);
  if (summaries.length === 0) return;

  const usableIds = new Set(all.filter((m) => !isSummary(m)).map((m) => m.id));
  const cleaned = all.filter((mem) => {
    if (!isSummary(mem)) return true;
    const content = typeof mem.content === "string" ? mem.content : "";
    const repeats = (content.match(/Summary cluster:/g) || []).length;
    if (repeats >= 2) return false;
    const clusterKey = mem?.source?.clusterKey;
    if (clusterKey) {
      const ids = clusterKey.split(":").filter(Boolean);
      const hasAny = ids.some((id) => usableIds.has(id));
      if (!hasAny) return false;
    }
    return true;
  });

  const MAX_SUMMARIES = 12;
  const remainingSummaries = cleaned.filter(isSummary);
  if (remainingSummaries.length > MAX_SUMMARIES) {
    const toDrop = remainingSummaries
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(a.ts || "") || 0) - (Date.parse(b.ts || "") || 0)
      )
      .slice(0, remainingSummaries.length - MAX_SUMMARIES)
      .map((m) => m.id);
    const dropSet = new Set(toDrop);
    await updateMemories(cleaned.filter((m) => !dropSet.has(m.id)));
    return;
  }

  if (cleaned.length !== all.length) {
    await updateMemories(cleaned);
  }
}

async function markMemoriesUsed(ids) {
  if (!ids || ids.length === 0) return;
  const all = await loadAllMemories();
  let changed = false;
  const now = new Date().toISOString();
  const promoted = [];
  const updated = all.map((mem) => {
    if (!ids.includes(mem.id)) return mem;
    changed = true;
    const nextUseCount = (mem.useCount || 0) + 1;
    const shouldPromote =
      mem.confirmed !== false &&
      nextUseCount >= 5 &&
      !(Array.isArray(mem.tags) && mem.tags.includes("pin"));
    return {
      ...mem,
      lastUsed: now,
      useCount: nextUseCount,
      confidence: Math.max(mem.confidence || 0, 0.9),
      tags: shouldPromote
        ? Array.from(new Set([...(mem.tags || []), "pin"]))
        : mem.tags || [],
      promotedAt: shouldPromote ? now : mem.promotedAt || null,
    };
  });
  if (changed) {
    await updateMemories(updated);
  }
}

async function markMemoriesInvalid(ids) {
  if (!ids || ids.length === 0) return;
  const all = await loadAllMemories();
  let changed = false;
  const now = new Date().toISOString();
  const updated = all.map((mem) => {
    if (!ids.includes(mem.id)) return mem;
    changed = true;
    return {
      ...mem,
      confirmed: false,
      invalidatedAt: now,
    };
  });
  if (changed) {
    await updateMemories(updated);
  }
}

// ── Skills ──────────────────────────────────────────────────────────────────

async function loadSkillsSummary() {
  try {
    const entries = await readdir(PATHS.skills, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
    return names.length > 0
      ? `Available skills: ${names.join(", ")}`
      : "Available skills: none";
  } catch {
    return "Available skills: none";
  }
}

// ── Tool registry ───────────────────────────────────────────────────────────

const toolSkillDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tools",
  "skills"
);
const registry = new ToolRegistry({ skillDirs: [toolSkillDir] });
const allowWriteToEmber =
  process.env.EMBER_ALLOW_EMBER_WRITE === "true" ||
  process.env.EMBER_AGENT_ROLE === "coder" ||
  false;
const workspaceDefaults = getWorkspaceDefaults();
const protectedPaths = getProtectedPaths(workspaceDefaults.homeDir);
const fsPolicy = createFsPolicy({
  emberRoots: [process.cwd()],
  allowWriteToEmber,
  ...workspaceDefaults,
  protectedPathsWrite: protectedPaths.protectedWrite,
  protectedPathsDelete: protectedPaths.protectedDelete,
  protectedCommandPatterns: protectedPaths.protectedCommandPatterns,
});

// Register built-in tools

registry.register({
  name: "save_memory",
  description:
    "Save a fact, preference, or learned pattern to long-term memory. Use this when the user tells you something worth remembering, or when you learn something important.",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact or pattern to remember" },
      type: {
        type: "string",
        description: "Memory type: preference, identity, project, workflow, reference",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Categorization tags (e.g. preference, fact, skill)",
      },
      confirmed: {
        type: "boolean",
        description: "Whether the memory is confirmed by the user",
      },
      approved: {
        type: "boolean",
        description: "Whether the memory is approved for use",
      },
      confidence: {
        type: "number",
        description: "Confidence 0-1 if inferred",
      },
    },
    required: ["content"],
  },
  keywords: ["save", "memory", "remember"],
  handler: async (args) => {
    const mem = await createMemory(
      args.content,
      args.tags || [],
      args._source || null,
      {
        type: args.type,
        confirmed: args.confirmed,
        approved: args.approved,
        confidence: args.confidence,
      }
    );
    return {
      saved: mem.saved === true,
      duplicate: mem.duplicate === true,
      id: mem.id,
    };
  },
});

registry.register({
  name: "update_memory",
  description: "Update an existing memory when the user corrects or revises it.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Memory id to update" },
      content: { type: "string", description: "Updated memory content" },
      tags: { type: "array", items: { type: "string" } },
      type: { type: "string" },
      confirmed: { type: "boolean" },
      approved: { type: "boolean" },
    },
    required: ["id", "content"],
  },
  keywords: ["update", "memory", "correct"],
  handler: async (args) => {
    if (!args?.id || !args?.content) {
      return { updated: false, error: "id and content are required" };
    }
    try {
      const result = await updateMemoryById(args.id, args);
      return { updated: result.updated, id: args.id, error: result.error };
    } catch (error) {
      return { updated: false, error: error instanceof Error ? error.message : "update failed" };
    }
  },
});

registry.register({
  name: "search_memory",
  description:
    "Search long-term memories for relevant facts, preferences, or patterns. Use this when you need to recall something previously learned.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term to find in memories" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Filter by tags",
      },
    },
    required: [],
  },
  keywords: ["search", "memory", "recall"],
  handler: async (args) => {
    const results = await searchMemories(args.query || "", args.tags || []);
    return {
      memories: results.slice(-10).map((m) => ({
        id: m.id,
        content: m.content,
        tags: m.tags,
      })),
    };
  },
});

registry.register({
  name: "github_repo",
  description:
    "Create or verify GitHub repositories using stored credentials.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "create | verify",
      },
      name: { type: "string", description: "Repository name" },
      owner: { type: "string", description: "Owner (defaults to configured user)" },
      private: { type: "boolean", description: "Create as private (default false)" },
      description: { type: "string", description: "Repository description" },
    },
    required: ["action"],
  },
  keywords: ["github", "repo", "create", "verify", "push"],
  handler: async (args) => {
    const cfg = await loadConfig();
    const token = String(cfg.githubToken || "").trim();
    const username = String(cfg.githubUsername || "").trim();
    if (!token || !username) {
      return { error: "GitHub credentials are not configured" };
    }

    const action = String(args.action || "").trim();
    const owner = String(args.owner || username).trim();
    const name = String(args.name || "").trim();
    if (!name) return { error: "name is required" };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ember-agent",
    };

    if (action === "create") {
      const payload = {
        name,
        private: Boolean(args.private),
        description: typeof args.description === "string" ? args.description : "",
        auto_init: false,
      };
      const res = await fetchWithTimeout("https://api.github.com/user/repos", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          error: data?.message || `GitHub create failed (${res.status})`,
          status: res.status,
        };
      }
      return {
        created: true,
        name: data?.name || name,
        owner: data?.owner?.login || owner,
        html_url: data?.html_url,
        clone_url: data?.clone_url,
      };
    }

    if (action === "verify") {
      const res = await fetchWithTimeout(
        `https://api.github.com/repos/${owner}/${name}`,
        { method: "GET", headers }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          exists: false,
          error: data?.message || `GitHub verify failed (${res.status})`,
          status: res.status,
        };
      }
      return {
        exists: true,
        name: data?.name || name,
        owner: data?.owner?.login || owner,
        html_url: data?.html_url,
        clone_url: data?.clone_url,
      };
    }

    return { error: "Unknown action" };
  },
});

registry.register({
  name: "web_search",
  description:
    "Search the web quickly for current information and return result titles, URLs, and snippets. Use this first for simple current-info lookups; only fetch pages when snippets are not enough.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Maximum results to return (1-10)" },
      site: { type: "string", description: "Optional site/domain filter such as example.com" },
    },
    required: ["query"],
  },
  keywords: ["search", "web", "internet", "lookup", "google"],
  handler: async (args) => {
    const cfg = await loadConfig();
    if (!cfg.webSearchEnabled) {
      return { error: "Web search is disabled in settings" };
    }
    const query = String(args.query || "").trim();
    if (!query) return { error: "query is required" };
    const limit = Math.max(1, Math.min(10, Number.parseInt(String(args.limit || "5"), 10) || 5));
    const site = String(args.site || "").trim().toLowerCase();
    const siteFilter = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(site) ? site : "";
    const effectiveQuery = siteFilter ? `${query} site:${siteFilter}` : query;
    const apiUrl =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(effectiveQuery)}` +
      "&format=json&no_html=1&skip_disambig=1&no_redirect=1";
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(effectiveQuery)}`;
    try {
      const apiRes = await fetchWithTimeout(
        apiUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ember-agent/1.0)",
            Accept: "application/json,text/plain,*/*",
          },
        },
        15000
      );
      let results = [];
      if (apiRes.ok) {
        const apiData = await apiRes.json().catch(() => ({}));
        results = parseDuckDuckGoInstantAnswer(apiData, limit);
      }

      if (results.length < limit) {
        const htmlRes = await fetchWithTimeout(
          htmlUrl,
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; ember-agent/1.0)",
              Accept: "text/html,application/xhtml+xml",
            },
          },
          15000
        );
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const fallbackResults = parseDuckDuckGoResults(html, limit);
          for (const item of fallbackResults) {
            if (results.length >= limit) break;
            if (!results.some((existing) => existing.url === item.url)) {
              results.push(item);
            }
          }
        }
      }

      return {
        query,
        effectiveQuery,
        site: siteFilter,
        results: results.slice(0, limit),
        count: Math.min(results.length, limit),
        engine: "duckduckgo",
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Search request failed",
        query,
      };
    }
  },
});

registry.register({
  name: "fetch_url",
  description:
    "Fetch a URL and return readable text content from the page. Use this after web_search when you need the page details.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      maxChars: { type: "number", description: "Maximum text characters to return" },
    },
    required: ["url"],
  },
  keywords: ["fetch", "url", "scrape", "webpage", "page", "read"],
  handler: async (args) => {
    const cfg = await loadConfig();
    if (!cfg.webSearchEnabled) {
      return { error: "Web search is disabled in settings" };
    }
    const targetUrl = String(args.url || "").trim();
    if (!targetUrl) return { error: "url is required" };
    const maxChars = Math.max(
      500,
      Math.min(20000, Number.parseInt(String(args.maxChars || "6000"), 10) || 6000)
    );
    try {
      const res = await fetchWithTimeout(
        targetUrl,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; ember-agent/1.0)",
            Accept: "text/html,text/plain,application/xhtml+xml",
          },
        },
        20000
      );
      if (!res.ok) {
        return { error: `Fetch failed (${res.status})`, status: res.status, url: targetUrl };
      }
      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();
      const extracted = contentType.includes("html")
        ? extractReadableContent(body)
        : {
            title: "",
            text: String(body || "").trim(),
            excerpt: "",
            byline: "",
            publishedTime: "",
            siteName: "",
            canonicalUrl: "",
            lang: "",
            extraction: "plain-text",
            paywallLikely: false,
          };
      const title = extracted.title || (contentType.includes("html") ? extractHtmlTitle(body) : "");
      const fullText = extracted.text || (contentType.includes("html") ? stripHtmlToText(body) : "");
      const text = fullText.slice(0, maxChars);
      return {
        url: targetUrl,
        title,
        contentType,
        text,
        excerpt: extracted.excerpt,
        byline: extracted.byline,
        publishedTime: extracted.publishedTime,
        siteName: extracted.siteName,
        canonicalUrl: extracted.canonicalUrl,
        lang: extracted.lang,
        extraction: extracted.extraction,
        paywallLikely: extracted.paywallLikely,
        truncated: fullText.length > maxChars,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Fetch failed",
        url: targetUrl,
      };
    }
  },
});

registry.register({
  name: "task_runner",
  description:
    "Create and manage lightweight tasks with steps. Use to store a todo list and iterate steps until done.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "create | add_steps | next_step | complete_step | get | list",
      },
      taskId: { type: "string", description: "Task id" },
      title: { type: "string", description: "Task title (create only)" },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Steps to add (create/add_steps)",
      },
      stepId: { type: "string", description: "Step id (complete_step)" },
      note: { type: "string", description: "Optional completion note" },
    },
    required: ["action"],
  },
  keywords: ["task", "todo", "list", "steps", "plan", "progress"],
  handler: async (args) => {
    const action = String(args.action || "").trim();
    if (action === "create") {
      return await createTask({ title: args.title, steps: args.steps });
    }
    if (action === "add_steps") {
      if (!args.taskId) return { error: "taskId is required" };
      return await addTaskSteps(args.taskId, args.steps);
    }
    if (action === "next_step") {
      if (!args.taskId) return { error: "taskId is required" };
      return await getNextStep(args.taskId);
    }
    if (action === "complete_step") {
      if (!args.taskId || !args.stepId) {
        return { error: "taskId and stepId are required" };
      }
      return await completeStep(args.taskId, args.stepId, args.note);
    }
    if (action === "get") {
      if (!args.taskId) return { error: "taskId is required" };
      return await getTask(args.taskId);
    }
    if (action === "list") {
      return await listTasks();
    }
    return { error: "Unknown action" };
  },
});

registerFilesystemTools(registry, { policy: fsPolicy });

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function handleBodyErrors(res, error) {
  if (error && error.code === "BAD_JSON") {
    sendJson(res, 400, { error: "Invalid JSON" });
    return true;
  }
  if (error && error.code === "ENTITY_TOO_LARGE") {
    sendJson(res, 413, { error: "Request too large" });
    return true;
  }
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.code = "ENTITY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON");
    error.code = "BAD_JSON";
    throw error;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildProviderRegistry(config) {
  const providerRegistry = new ProviderRegistry();
  providerRegistry.loadProviders(config?.providers || []);
  return providerRegistry;
}

function resolveRoleExecution(config, providerRegistry, requestedRoleId) {
  const roleAssignments = normalizeRoleAssignments(
    config?.roleAssignments,
    config?.providers,
    config?.modelRoles
  );
  const requestedRole = getRole(requestedRoleId);
  const enabledProviders = providerRegistry
    .listProviders({ includeDisabled: false })
    .filter(Boolean);
  const authReadyProviders = enabledProviders.filter((provider) =>
    hasUsableProviderAuth(provider)
  );
  const fallbackProvider =
    authReadyProviders[0] ||
    providerRegistry.getProvider("local-qwen") ||
    enabledProviders[0] ||
    providerRegistry.listProviders({ includeDisabled: true })[0] ||
    null;
  const requestedAssignment =
    roleAssignments?.[requestedRole.id] || roleAssignments?.default;
  const requestedProvider =
    providerRegistry.getProvider(requestedAssignment?.providerId) || null;
  const useFallback =
    !requestedProvider || requestedProvider.enabled === false;
  const provider = useFallback ? fallbackProvider : requestedProvider;
  const resolvedRoleId =
    provider || requestedRole.id === "default" ? requestedRole.id : "default";
  const resolvedProvider = provider || fallbackProvider;
  const assignment = useFallback
    ? {
        providerId: resolvedProvider?.id || requestedAssignment?.providerId || "",
        model:
          resolvedProvider?.defaultModel ||
          requestedAssignment?.model ||
          config?.model ||
          LOCAL_QWEN_MODEL,
      }
    : requestedAssignment;
  const model =
    assignment?.model ||
    resolvedProvider?.defaultModel ||
    config?.model ||
    LOCAL_QWEN_MODEL;

  return {
    roleId: resolvedRoleId,
    role: getRole(resolvedRoleId),
    assignment: {
      providerId: resolvedProvider?.id || assignment?.providerId || "",
      model,
    },
    provider: resolvedProvider,
    fellBack: useFallback,
    requestedRoleId: requestedRoleId || "default",
    requestedProviderId: requestedAssignment?.providerId || "",
  };
}

function buildRoleScopedConfig(config, roleExecution) {
  const provider = roleExecution?.provider || null;
  const model = roleExecution?.assignment?.model || config?.model;
  const roleAssignments = normalizeRoleAssignments(
    config?.roleAssignments,
    config?.providers,
    config?.modelRoles
  );
  return {
    ...config,
    provider: provider?.id || config?.provider,
    endpoint: provider?.endpoint || config?.endpoint,
    model,
    contextWindow:
      provider?.maxContextWindow || config?.contextWindow || DEFAULT_CONFIG.contextWindow,
    modelRoles: {
      ...buildLegacyModelRoles(roleAssignments, config?.modelRoles),
      assistant: model,
    },
    roleAssignments,
    activeRole: roleExecution?.roleId || "default",
    activeProviderName: provider?.name || "",
  };
}

function hasUsableProviderAuth(provider) {
  if (!provider) return false;
  const authType = String(provider.authType || "api-key").trim();
  if (authType === "none") return true;
  if (authType === "env") {
    const envVar = String(provider.apiKeyEnvVar || "").trim();
    return Boolean(envVar && process.env[envVar]);
  }
  return Boolean(String(provider.apiKey || "").trim());
}

function isRecoverableProviderError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (!message) return false;
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("loading model") ||
    message.includes("provider error 429") ||
    message.includes("provider error 500") ||
    message.includes("provider error 502") ||
    message.includes("provider error 503") ||
    message.includes("provider error 504") ||
    message.includes("quota") ||
    message.includes("provider error 401") ||
    message.includes("provider error 403") ||
    message.includes("authentication_error") ||
    message.includes("invalid bearer token") ||
    message.includes("invalid api key") ||
    message.includes("unauthorized")
  );
}

function buildRoleFallbackCandidates(providerRegistry, roleExecution) {
  const currentProviderId = roleExecution?.provider?.id || "";
  return providerRegistry
    .listProviders({ includeDisabled: false })
    .filter((provider) => provider?.id && provider.id !== currentProviderId)
    .filter((provider) => hasUsableProviderAuth(provider) || provider.authType === "none")
    .map((provider) => ({
      provider,
      assignment: {
        providerId: provider.id,
        model: provider.defaultModel || provider.models?.[0] || roleExecution?.assignment?.model || "",
      },
    }));
}

async function callRoleProvider(providerRegistry, roleExecution, payload, options = {}) {
  if (!roleExecution?.provider?.id) {
    throw new Error("No provider is configured for this role");
  }
  const attempt = async (providerId, model) =>
    providerRegistry.callLLM(providerId, model, payload, options);

  try {
    return await attempt(
      roleExecution.provider.id,
      roleExecution.assignment?.model
    );
  } catch (error) {
    if (!isRecoverableProviderError(error)) {
      throw error;
    }

    const message = String(error?.message || error || "").toLowerCase();
    if (message.includes("loading model") || message.includes("fetch failed")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        return await attempt(
          roleExecution.provider.id,
          roleExecution.assignment?.model
        );
      } catch {}
    }

    const fallbacks = buildRoleFallbackCandidates(providerRegistry, roleExecution);
    for (const fallback of fallbacks) {
      try {
        const data = await attempt(
          fallback.provider.id,
          fallback.assignment.model
        );
        roleExecution.provider = fallback.provider;
        roleExecution.assignment = fallback.assignment;
        roleExecution.fellBack = true;
        roleExecution.fallbackReason = String(error?.message || error || "");
        if (typeof options.onProviderFallback === "function") {
          await options.onProviderFallback({
            failedProviderId: roleExecution.requestedProviderId || "",
            nextProviderId: fallback.provider.id,
            error,
          });
        }
        return data;
      } catch {}
    }
    throw error;
  }
}

const MAX_COMPAT_RETRIES = 8;

function resolveRoleCompatTarget(roleExecution) {
  return {
    providerId: roleExecution?.provider?.id || "",
    model: roleExecution?.assignment?.model || "",
  };
}

async function persistPayloadCompatDisabledParams(providerId, model, unsupportedParams) {
  const params = Array.isArray(unsupportedParams) ? unsupportedParams : [];
  if (!providerId || params.length === 0) return false;
  return await withFileLock(PATHS.config, async () => {
    const current = await loadConfig();
    const merged = mergeUnsupportedPayloadParams(
      current.payloadCompatDisabledParams,
      {
        providerId,
        model,
        unsupportedParams: params,
      }
    );
    if (!merged.changed) return false;
    const nextConfig = {
      ...current,
      payloadCompatDisabledParams: merged.cache,
    };
    await writeFile(
      PATHS.config,
      `${JSON.stringify(serializePersistedConfig(nextConfig), null, 2)}\n`,
      "utf8"
    );
    return true;
  });
}

async function callRoleProviderWithCompat(
  providerRegistry,
  roleExecution,
  payload,
  options = {}
) {
  const {
    compatConfig = null,
    onCompatRetry = null,
    persistCompatCache = true,
    ...providerOptions
  } = options || {};
  const compatTarget = resolveRoleCompatTarget(roleExecution);
  let disabledParams = Array.from(
    new Set([
      ...(Array.isArray(providerOptions.disabledParams)
        ? providerOptions.disabledParams
        : []),
      ...getCachedUnsupportedPayloadParams(
        compatConfig?.payloadCompatDisabledParams,
        compatTarget
      ),
    ])
  );

  let retries = 0;
  while (true) {
    try {
      return await callRoleProvider(providerRegistry, roleExecution, payload, {
        ...providerOptions,
        disabledParams,
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      const unsupportedParams = extractUnsupportedPayloadParams(errorText);
      if (unsupportedParams.length === 0 || retries >= MAX_COMPAT_RETRIES) {
        throw error;
      }
      const nextTarget = resolveRoleCompatTarget(roleExecution);
      const merged = mergeUnsupportedPayloadParams(
        compatConfig?.payloadCompatDisabledParams,
        {
          providerId: nextTarget.providerId,
          model: nextTarget.model,
          unsupportedParams,
        }
      );
      const nextDisabled = Array.from(
        new Set([...disabledParams, ...merged.disabledParams, ...unsupportedParams])
      );
      if (nextDisabled.length === disabledParams.length) {
        throw error;
      }
      retries += 1;
      disabledParams = nextDisabled;
      if (compatConfig && merged.changed) {
        compatConfig.payloadCompatDisabledParams = merged.cache;
        if (persistCompatCache) {
          try {
            await persistPayloadCompatDisabledParams(
              nextTarget.providerId,
              nextTarget.model,
              unsupportedParams
            );
          } catch {}
        }
      }
      if (typeof onCompatRetry === "function") {
        await onCompatRetry({
          disabledParams,
          errorText,
          unsupportedParams,
          retry: retries,
        });
      }
    }
  }
}

function normalizeWorkflowOptions(workflow) {
  if (!workflow || typeof workflow !== "object") {
    return {
      forcedRole: "",
      disableOrchestration: false,
      persistUserMessage: true,
      persistAssistantMessage: true,
      contextMessage: "",
      noTools: false,
    };
  }
  return {
    forcedRole:
      typeof workflow.forcedRole === "string" ? workflow.forcedRole.trim() : "",
    disableOrchestration: workflow.disableOrchestration === true,
    persistUserMessage: workflow.persistUserMessage !== false,
    persistAssistantMessage: workflow.persistAssistantMessage !== false,
    contextMessage:
      typeof workflow.contextMessage === "string"
        ? workflow.contextMessage.trim()
        : "",
    noTools: workflow.noTools === true,
  };
}

function trimPreview(text, limit = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 3)}...`
    : normalized;
}

function describeLlmResponseForProgress(data, roleId) {
  const role = getRole(roleId);
  const message = data?.choices?.[0]?.message || {};
  const text = typeof message?.content === "string" ? message.content.trim() : "";
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  if (roleId === "auditor" && text) {
    const audit = parseAuditorResult(text);
    const issueCount = Array.isArray(audit.issues) ? audit.issues.length : 0;
    return `${role.name} scored the work ${audit.score.toFixed(1)}/10 and returned ${audit.verdict}. ${issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? "" : "s"} found.` : "No blocking issues found."}`;
  }

  if (toolCalls.length > 0) {
    const toolNames = toolCalls
      .map((toolCall) => toolCall?.function?.name)
      .filter(Boolean);
    if (toolNames.length > 0) {
      return `${role.name} decided the next step is to use ${toolNames.join(", ")}.`;
    }
  }

  if (text) {
    return `${role.name}: ${trimPreview(text)}`;
  }

  return `${role.name} responded.`;
}

function shouldRunChainedWorkflow(roleId, userContent, workflowOptions) {
  if (workflowOptions.disableOrchestration) return false;
  if (!["planner", "coder"].includes(roleId)) return false;
  const text = String(userContent || "").toLowerCase();
  if (/\b(review|audit|check my code|quality check)\b/.test(text)) return false;
  return true;
}

function assertRoleDelegation(fromRoleId, toRoleId) {
  if (!canRoleDelegate(fromRoleId, toRoleId)) {
    throw new Error(`Role ${fromRoleId} is not allowed to delegate to ${toRoleId}`);
  }
}

function buildPlannerStagePrompt(userContent) {
  const plannerRole = getRole("planner");
  const defaultRole = getRole("default");
  const coderRole = getRole("coder");
  return [
    buildRoleContractPrompt("planner"),
    "",
    "Create the execution plan for this request from ground zero to a production-ready result.",
    "Return JSON only with this shape:",
    '{"route":"coder","summary":"...","plan":["..."],"acceptanceCriteria":["..."],"files":["..."],"commands":["..."],"risks":["..."],"reason":"..."}',
    "Rules:",
    `- route must be either "${defaultRole.id}" or "${coderRole.id}".`,
    `- Choose "${defaultRole.id}" only for truly small tasks that do not require substantial implementation, multi-file changes, or deep tool work.`,
    `- Choose "${coderRole.id}" for any build, app, refactor, debugging, or production-readiness task.`,
    "- The plan must be detailed enough for the next role to execute without asking the user for missing steps.",
    "- You do not write code. Planning only.",
    "",
    `[Route options]\n${defaultRole.id} - ${defaultRole.description}\n${coderRole.id} - ${coderRole.description}`,
    "",
    `[User request]\n${userContent}`,
  ].join("\n");
}

function buildCoderStagePrompt({
  userContent,
  plannerOutput = "",
  auditFeedback = "",
  previousCoderOutput = "",
  auditorIssues = [],
  iteration = 1,
}) {
  const coderRole = getRole("coder");
  const auditorRole = getRole("auditor");
  const sections = [
    buildRoleContractPrompt("coder"),
    "",
    "Implement the request completely in the current workspace.",
    "Execute the approved plan step by step. Do not skip planned verification or production-readiness work.",
    "Use tools, modify files, run verification, and finish only when the implementation is materially complete.",
    `Your output will be handed to ${auditorRole.name} next, so include concrete verification evidence they can inspect.`,
    "At the end, include a concise build report with changed files, commands run, verification results, and any remaining caveats.",
    "",
    `[Next role]\n${auditorRole.id} - ${auditorRole.description}`,
    "",
    `[Original request]\n${userContent}`,
  ];
  if (plannerOutput.trim()) {
    sections.push("", `[Approved plan]\n${plannerOutput.trim()}`);
  }
  if (auditFeedback.trim()) {
    sections.push(
      "",
      `[Audit fixes to apply]\n${auditFeedback.trim()}`,
      "Address every issue before finishing this iteration."
    );
  } else if (iteration === 1) {
    sections.push("", "This is the initial implementation pass.");
  }
  if (iteration > 1 && previousCoderOutput.trim()) {
    sections.push(
      "",
      `[Previous build report — iteration ${iteration - 1}]\n${previousCoderOutput.trim()}`,
      "The files listed above already exist in the workspace. Read them with tools before modifying.",
      "Focus on fixing the audit issues. Do not start from scratch."
    );
  }
  if (Array.isArray(auditorIssues) && auditorIssues.length > 0) {
    const issueLines = auditorIssues.map((issue, i) => {
      const parts = [
        `${i + 1}. [${(issue.severity || "issue").toUpperCase()}]`,
        issue.file ? `${issue.file}:` : "",
        issue.description || "",
        issue.fix ? `→ Fix: ${issue.fix}` : "",
      ].filter(Boolean);
      return parts.join(" ");
    });
    sections.push("", `[Audit issues to resolve]\n${issueLines.join("\n")}`);
  }
  return sections.join("\n");
}

function parsePlannerResult(text) {
  const rawJson = extractFirstJsonObject(text);
  if (!rawJson) {
    return {
      route: "coder",
      summary: "",
      plan: [String(text || "").trim()].filter(Boolean),
      acceptanceCriteria: [],
      files: [],
      commands: [],
      risks: [],
      reason: "Planner returned unstructured output; defaulting to coder.",
    };
  }
  try {
    const parsed = JSON.parse(rawJson);
    const routeRaw = typeof parsed.route === "string" ? parsed.route.trim() : "";
    const route = routeRaw === "default" ? "default" : "coder";
    const normalizeList = (value) =>
      Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
    return {
      route,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      plan: normalizeList(parsed.plan),
      acceptanceCriteria: normalizeList(parsed.acceptanceCriteria),
      files: normalizeList(parsed.files),
      commands: normalizeList(parsed.commands),
      risks: normalizeList(parsed.risks),
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    };
  } catch {
    return {
      route: "coder",
      summary: "",
      plan: [String(text || "").trim()].filter(Boolean),
      acceptanceCriteria: [],
      files: [],
      commands: [],
      risks: [],
      reason: "Planner JSON could not be parsed; defaulting to coder.",
    };
  }
}

function formatPlannerExecutionBrief(plannerResult) {
  const sections = [];
  if (plannerResult.summary) {
    sections.push(`[Planner summary]\n${plannerResult.summary}`);
  }
  if (plannerResult.plan.length > 0) {
    sections.push(`[Execution plan]\n${plannerResult.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  }
  if (plannerResult.acceptanceCriteria.length > 0) {
    sections.push(
      `[Acceptance criteria]\n${plannerResult.acceptanceCriteria
        .map((item, index) => `${index + 1}. ${item}`)
        .join("\n")}`
    );
  }
  if (plannerResult.files.length > 0) {
    sections.push(`[Relevant files]\n${plannerResult.files.join("\n")}`);
  }
  if (plannerResult.commands.length > 0) {
    sections.push(`[Expected commands]\n${plannerResult.commands.join("\n")}`);
  }
  if (plannerResult.risks.length > 0) {
    sections.push(`[Risks]\n${plannerResult.risks.join("\n")}`);
  }
  if (plannerResult.reason) {
    sections.push(`[Routing reason]\n${plannerResult.reason}`);
  }
  return sections.filter(Boolean).join("\n\n");
}

function buildAuditorStagePrompt({ userContent, coderOutput = "", iteration = 1 }) {
  const auditorRole = getRole("auditor");
  const coderRole = getRole("coder");
  return [
    buildRoleContractPrompt("auditor"),
    "",
    "You are reviewing the current workspace for production readiness.",
    "IMPORTANT: Before scoring, you MUST use your tools to independently verify the work:",
    "1. Use list_dir and read_file to inspect the actual files in the workspace.",
    "2. Use run_command to check for build errors, lint issues, or missing dependencies.",
    "3. Use verify_server to confirm the app runs if it is a web project.",
    "4. Only AFTER inspecting the real files and running verification, produce your final JSON verdict.",
    "",
    "Your final response (after all tool calls) must be JSON with this shape:",
    '{"score":8.5,"verdict":"PASS","summary":"...","issues":[{"severity":"critical|major|minor","file":"path","description":"...","fix":"..."}],"repairPrompt":"..."}',
    "",
    "Scoring rules:",
    "- Score from 0 to 10. Be fair but strict.",
    "- PASS only if score >= 8 and there are zero critical issues.",
    "- critical = app won't build, crashes, security vulnerability, missing core feature.",
    "- major = broken functionality, poor UX, missing validation, no error handling.",
    "- minor = style issues, missing comments, non-blocking improvements.",
    `- If FAIL, the repairPrompt must tell the ${coderRole.name} exactly what to fix. Be specific: name the file, the line, and the fix.`,
    "- Do NOT give a passing score just because the coder claimed success. Verify it yourself.",
    "",
    `[Next role on FAIL]\n${coderRole.id} - ${coderRole.description}`,
    "",
    `[Audit iteration]\n${iteration}`,
    "",
    `[Original request]\n${userContent}`,
    coderOutput.trim() ? `\n[Latest coder report]\n${coderOutput.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFinalSummaryPrompt({
  userContent,
  plannerOutput = "",
  latestCoderOutput = "",
  auditorReport = null,
  auditAttempts = 0,
}) {
  const defaultRole = getRole("default");
  return [
    buildRoleContractPrompt("default"),
    "",
    "Summarize what was built for the user.",
    `${defaultRole.name} is the only role that speaks to the user directly.`,
    "If this request produced a runnable app or site, make sure a local server is running before you answer by using start_dev_server and verify_server when appropriate.",
    "Keep the answer concise, mention the local URL if available, say where the code lives, and note the final audit score.",
    "",
    `[Original request]\n${userContent}`,
    plannerOutput.trim() ? `\n[Plan]\n${plannerOutput.trim()}` : "",
    latestCoderOutput.trim() ? `\n[Implementation report]\n${latestCoderOutput.trim()}` : "",
    auditorReport
      ? `\n[Audit result — after ${auditAttempts} iteration${auditAttempts === 1 ? "" : "s"}]\nScore: ${auditorReport.score}/10\nVerdict: ${auditorReport.verdict}\nSummary: ${auditorReport.summary}${
          auditorReport.issues.length > 0
            ? `\nIssues: ${auditorReport.issues
                .map((issue) => `[${issue.severity || "issue"}] ${issue.file || ""} ${issue.description || ""}`.trim())
                .join("; ")}`
            : "\nNo remaining issues."
        }`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseAuditorResult(text) {
  const rawText = String(text || "").trim();
  const rawJson = extractFirstJsonObject(rawText);
  if (!rawJson) {
    // Try to extract useful feedback from unstructured auditor output
    const feedbackLines = rawText
      .split("\n")
      .filter((line) => line.trim().length > 10)
      .slice(0, 10)
      .join("\n");
    return {
      score: 3,
      verdict: "FAIL",
      summary: "Auditor returned unstructured feedback.",
      issues: [
        {
          severity: "major",
          file: "",
          description: "Auditor could not produce structured JSON. Review the raw feedback below.",
          fix: "",
        },
      ],
      repairPrompt: feedbackLines
        ? `The auditor provided this unstructured feedback. Address every concern:\n${feedbackLines}`
        : "The auditor could not review the code. Re-verify your implementation: check that all files exist, the app builds without errors, and all requested features are implemented.",
    };
  }

  try {
    const parsed = JSON.parse(rawJson);
    const score =
      typeof parsed.score === "number"
        ? Math.max(0, Math.min(10, parsed.score))
        : 0;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.map((issue) => ({
          severity:
            typeof issue?.severity === "string" ? issue.severity : "minor",
          file: typeof issue?.file === "string" ? issue.file : "",
          description:
            typeof issue?.description === "string" ? issue.description : "",
          fix: typeof issue?.fix === "string" ? issue.fix : "",
        }))
      : [];
    const hasCritical = issues.some(
      (issue) => issue.severity === "critical" || issue.severity === "blocker"
    );
    const verdictRaw =
      typeof parsed.verdict === "string" ? parsed.verdict.toUpperCase() : "";
    const verdict =
      verdictRaw === "PASS" && score >= 8.5 && !hasCritical ? "PASS" : "FAIL";
    return {
      score,
      verdict,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      issues,
      repairPrompt:
        typeof parsed.repairPrompt === "string" && parsed.repairPrompt.trim()
          ? parsed.repairPrompt
          : issues
              .map((issue) =>
                [issue.file, issue.description, issue.fix].filter(Boolean).join(" - ")
              )
              .filter(Boolean)
              .join("\n") || "Review and fix all issues identified in the audit.",
    };
  } catch {
    return {
      score: 3,
      verdict: "FAIL",
      summary: "Auditor JSON could not be parsed.",
      issues: [
        {
          severity: "major",
          file: "",
          description: "Auditor output contained malformed JSON.",
          fix: "",
        },
      ],
      repairPrompt:
        "The auditor could not produce a valid report. Re-verify: check that all files exist, the app builds, and all features work. Fix any remaining issues.",
    };
  }
}

async function executeSilentWorkflowStage({
  conversationId,
  body,
  content,
  forcedRole,
  contextMessage = "",
  persistAssistantMessage = false,
  noTools = false,
}) {
  return handleChatProcess(
    createSyntheticJsonRequest({
      conversationId,
      content,
      config: body?.config,
      workflow: {
        forcedRole,
        disableOrchestration: true,
        persistUserMessage: false,
        persistAssistantMessage,
        contextMessage,
        noTools,
      },
    }),
    createNullResponse()
  ).then((result) => {
    if (result?.error) {
      throw new Error(result.details ? `${result.error}: ${result.details}` : result.error);
    }
    return result;
  });
}

async function runChainedWorkflow({
  conversationId,
  userContent,
  body,
  initialRole,
}) {
  if (initialRole === "planner") {
    assertRoleDelegation("planner", "coder");
    assertRoleDelegation("planner", "default");
  }
  assertRoleDelegation("coder", "auditor");
  assertRoleDelegation("auditor", "coder");
  assertRoleDelegation("auditor", "default");

  const startedAt = Date.now();
  const workflowType =
    initialRole === "planner"
      ? "planner-coder-auditor"
      : "coder-auditor";
  await logEvent("workflow_started", {
    conversationId,
    workflowType,
    initialRole,
  });

  let plannerOutput = "";
  let plannerDecision = null;
  if (initialRole === "planner") {
    updateChatProgress(conversationId, "running", "Planner stage started", {
      kind: "workflow",
      phase: "planner",
    });
    const plannerResult = await executeSilentWorkflowStage({
      conversationId,
      body,
      forcedRole: "planner",
      content: buildPlannerStagePrompt(userContent),
      noTools: true,
    });
    plannerDecision = parsePlannerResult(plannerResult?.content || "");
    plannerOutput = formatPlannerExecutionBrief(plannerDecision);
    updateChatProgress(conversationId, "running", "Planner stage completed", {
      kind: "workflow",
      phase: "planner_done",
    });
    updateChatProgress(
      conversationId,
      "running",
      `Planner routed the task to ${plannerDecision.route}`,
      {
        kind: "workflow",
        phase: `planner_route_${plannerDecision.route}`,
        role: "planner",
      }
    );
    if (plannerDecision.route === "default") {
      const defaultResult = await executeSilentWorkflowStage({
        conversationId,
        body,
        forcedRole: "default",
        persistAssistantMessage: true,
        content: [
          buildRoleContractPrompt("default"),
          "",
          "Handle this small task directly for the user.",
          "Use the planner guidance below, keep the response concise, and complete the request end to end if possible.",
          "",
          `[Original request]\n${userContent}`,
          plannerOutput ? `\n[Planner guidance]\n${plannerOutput}` : "",
        ].join("\n"),
      });
      updateChatProgress(conversationId, "completed", "Workflow completed", {
        kind: "workflow",
        phase: "done",
      });
      return {
        content: defaultResult?.content || "",
        meta: {
          ...(defaultResult?.meta || {}),
          workflow: "planner-default",
          plannerRoute: "default",
          workflowLoops: 0,
          auditScore: null,
          auditVerdict: null,
          workflowElapsedMs: Date.now() - startedAt,
        },
      };
    }
  }

  const maxAuditLoops =
    typeof body?.config?.maxAuditLoops === "number" && body.config.maxAuditLoops > 0
      ? Math.min(body.config.maxAuditLoops, 20)
      : 10;
  let latestCoderOutput = "";
  let auditorReport = null;
  let auditAttempts = 0;

  while (auditAttempts < maxAuditLoops) {
    const iteration = auditAttempts + 1;
    updateChatProgress(
      conversationId,
      "running",
      `Coder stage ${iteration}/${maxAuditLoops} started`,
      {
        kind: "workflow",
        phase: "coder",
        iteration,
        maxIterations: maxAuditLoops,
      }
    );
    const coderResult = await executeSilentWorkflowStage({
      conversationId,
      body,
      forcedRole: "coder",
      content: buildCoderStagePrompt({
        userContent,
        plannerOutput,
        auditFeedback: auditorReport?.repairPrompt || "",
        previousCoderOutput: iteration > 1 ? latestCoderOutput : "",
        auditorIssues: auditorReport?.issues || [],
        iteration,
      }),
      contextMessage:
        iteration > 1 && auditorReport?.repairPrompt
          ? `[Previous audit — score ${auditorReport.score.toFixed(1)}/10 (${auditorReport.verdict})]\n${auditorReport.repairPrompt}`
          : "",
    });
    latestCoderOutput = String(coderResult?.content || "").trim();
    updateChatProgress(conversationId, "running", `Coder stage ${iteration} completed`, {
      kind: "workflow",
      phase: "coder_done",
      iteration,
    });

    updateChatProgress(conversationId, "running", `Auditor stage ${iteration} started`, {
      kind: "workflow",
      phase: "auditor",
      iteration,
    });
    const auditorResult = await executeSilentWorkflowStage({
      conversationId,
      body,
      forcedRole: "auditor",
      content: buildAuditorStagePrompt({
        userContent,
        coderOutput: latestCoderOutput,
        iteration,
      }),
    });
    auditorReport = parseAuditorResult(auditorResult?.content || "");
    auditAttempts += 1;

    const criticalCount = (auditorReport.issues || []).filter(
      (i) => i.severity === "critical" || i.severity === "blocker"
    ).length;
    const majorCount = (auditorReport.issues || []).filter(
      (i) => i.severity === "major"
    ).length;
    updateChatProgress(
      conversationId,
      "running",
      `Audit ${iteration}: score ${auditorReport.score.toFixed(1)}/10 (${auditorReport.verdict}) — ${criticalCount} critical, ${majorCount} major`,
      {
        kind: "workflow",
        phase: auditorReport.verdict === "PASS" ? "auditor_pass" : "auditor_fail",
        iteration,
        score: auditorReport.score,
        criticalCount,
        majorCount,
      }
    );

    if (auditorReport.verdict === "PASS") {
      break;
    }
  }

  const finalSummaryResult = await executeSilentWorkflowStage({
    conversationId,
    body,
    forcedRole: "default",
    persistAssistantMessage: true,
    content: buildFinalSummaryPrompt({
      userContent,
      plannerOutput,
      latestCoderOutput,
      auditorReport,
      auditAttempts,
    }),
  });

  const finalPayload = {
    content: finalSummaryResult?.content || "",
    meta: {
      ...(finalSummaryResult?.meta || {}),
      workflow: workflowType,
      workflowLoops: auditAttempts,
      auditScore: auditorReport?.score ?? null,
      auditVerdict: auditorReport?.verdict || null,
      workflowElapsedMs: Date.now() - startedAt,
    },
  };

  await logEvent("workflow_completed", {
    conversationId,
    workflowType,
    auditAttempts,
    auditScore: auditorReport?.score ?? null,
    verdict: auditorReport?.verdict || null,
  });

  updateChatProgress(conversationId, "completed", "Workflow completed", {
    kind: "workflow",
    phase: "done",
  });

  return finalPayload;
}

async function runRoleAndSummarizeWorkflow({
  conversationId,
  userContent,
  body,
  roleId,
}) {
  const role = getRole(roleId);
  assertRoleDelegation(roleId, "default");
  updateChatProgress(conversationId, "running", `${role.name} stage started`, {
    kind: "workflow",
    phase: roleId,
    role: roleId,
  });

  const stageResult = await executeSilentWorkflowStage({
    conversationId,
    body,
    forcedRole: roleId,
    content: userContent,
  });

  updateChatProgress(conversationId, "running", `${role.name} stage completed`, {
    kind: "workflow",
    phase: `${roleId}_done`,
    role: roleId,
  });

  const finalSummaryResult = await executeSilentWorkflowStage({
    conversationId,
    body,
    forcedRole: "default",
    persistAssistantMessage: true,
    content: [
      buildRoleContractPrompt("default"),
      "",
      "Summarize the specialist agent's work for the user in plain English.",
      "Explain what happened, where the relevant code or output lives, and what the user should look at next.",
      "",
      `[Original request]\n${userContent}`,
      `\n[${role.name} output]\n${String(stageResult?.content || "").trim()}`,
    ].join("\n"),
  });

  return {
    content: finalSummaryResult?.content || "",
    meta: {
      ...(finalSummaryResult?.meta || {}),
      workflow: `${roleId}-default`,
      specialistRole: roleId,
    },
  };
}

function resolveSearchResultUrl(rawUrl) {
  const urlText = String(rawUrl || "").trim();
  if (!urlText) return "";
  try {
    const parsed = new URL(urlText, "https://duckduckgo.com");
    if (parsed.hostname.endsWith("duckduckgo.com")) {
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return urlText;
  }
}

function parseDuckDuckGoResults(html, limit = 5) {
  const results = [];
  const regex =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>)([\s\S]*?)(?:<\/a>|<\/div>)/gi;
  let match;
  while ((match = regex.exec(String(html || ""))) && results.length < limit) {
    const url = resolveSearchResultUrl(match[1]);
    const title = stripHtmlToText(match[2]).slice(0, 200);
    const snippet = stripHtmlToText(match[3]).slice(0, 400);
    if (!url || !title) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function flattenDuckDuckGoTopics(items, output = []) {
  for (const item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item?.Topics)) {
      flattenDuckDuckGoTopics(item.Topics, output);
      continue;
    }
    if (item && (item.Text || item.FirstURL)) {
      output.push(item);
    }
  }
  return output;
}

function parseDuckDuckGoInstantAnswer(data, limit = 5) {
  const results = [];
  const addResult = (title, url, snippet, source = "instant_answer") => {
    const safeTitle = String(title || "").trim();
    const safeUrl = String(url || "").trim();
    const safeSnippet = String(snippet || "").trim();
    if (!safeTitle || !safeUrl) return;
    if (results.some((item) => item.url === safeUrl)) return;
    results.push({
      title: safeTitle.slice(0, 200),
      url: safeUrl,
      snippet: safeSnippet.slice(0, 400),
      source,
    });
  };

  if (data?.AbstractURL) {
    addResult(
      data?.Heading || "DuckDuckGo Instant Answer",
      data.AbstractURL,
      data.AbstractText || "",
      "abstract"
    );
  }

  for (const topic of flattenDuckDuckGoTopics(data?.RelatedTopics || [])) {
    if (results.length >= limit) break;
    addResult(topic?.Text || topic?.FirstURL, topic?.FirstURL, topic?.Text || "", "related");
  }

  return results.slice(0, limit);
}

async function embedText(text) {
  const input = typeof text === "string" ? text : "";
  if (!EMBEDDINGS_ENDPOINT) return buildEmbedding(input);
  try {
    const res = await fetchWithTimeout(EMBEDDINGS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    if (!res.ok) return buildEmbedding(input);
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    return Array.isArray(vec) ? vec : buildEmbedding(input);
  } catch {
    return buildEmbedding(input);
  }
}

function normalizeMemoryContent(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeIntentMemoryItems(items) {
  const allowedTypes = new Set([
    "identity",
    "preference",
    "project",
    "workflow",
    "reference",
  ]);
  const seen = new Set();
  const output = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const content = normalizeMemoryContent(item.content);
    if (!content) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const type = allowedTypes.has(String(item.type || "").trim())
      ? String(item.type).trim()
      : "reference";
    const tags = Array.isArray(item.tags)
      ? item.tags.map((tag) => normalizeMemoryContent(tag)).filter(Boolean).slice(0, 6)
      : [];
    output.push({ content, type, tags });
    if (output.length >= 5) break;
  }

  return output;
}

function extractFirstJsonObject(text) {
  const input = String(text || "");
  const start = input.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

function isMemoryAlreadyKnown(content, memories) {
  const normalized = normalizeMemoryContent(content).toLowerCase();
  if (!normalized) return false;
  return (Array.isArray(memories) ? memories : []).some(
    (mem) => normalizeMemoryContent(mem?.content).toLowerCase() === normalized
  );
}

function formatMemoryDirective(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const tags = Array.isArray(item.tags) && item.tags.length > 0
        ? ` [tags: ${item.tags.join(", ")}]`
        : "";
      return `${index + 1}. ${item.content} [type: ${item.type}]${tags}`;
    })
    .join(" ");
}

function guaranteeMinMemories(selected, allMemories, minCount = 2) {
  if (!Array.isArray(allMemories) || allMemories.length === 0) return selected;
  if (selected.length >= minCount) return selected;

  const selectedIds = new Set(selected.map((m) => m?.id).filter(Boolean));
  const usable = allMemories.filter(
    (m) =>
      m?.id &&
      !selectedIds.has(m.id) &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      !m.invalidatedAt
  );

  // Priority order: identity > pinned > preference > workflow > project > recent
  const priorityTags = ["identity", "pinned", "preference", "workflow", "project"];
  const backfill = [];
  for (const tag of priorityTags) {
    if (selected.length + backfill.length >= minCount) break;
    for (const mem of usable) {
      if (selected.length + backfill.length >= minCount) break;
      if (backfill.some((b) => b.id === mem.id)) continue;
      const tags = Array.isArray(mem.tags) ? mem.tags : [];
      const type = typeof mem.type === "string" ? mem.type : "";
      if (tags.includes(tag) || type === tag) {
        backfill.push(mem);
      }
    }
  }

  // If still short, grab most recent usable memories
  if (selected.length + backfill.length < minCount) {
    const backfillIds = new Set(backfill.map((m) => m.id));
    const remaining = usable
      .filter((m) => !backfillIds.has(m.id))
      .sort((a, b) => {
        const aTime = Date.parse(a.createdAt || a.ts || "0") || 0;
        const bTime = Date.parse(b.createdAt || b.ts || "0") || 0;
        return bTime - aTime;
      });
    for (const mem of remaining) {
      if (selected.length + backfill.length >= minCount) break;
      backfill.push(mem);
    }
  }

  return [...selected, ...backfill];
}

const KNOWN_TOOL_NAMES = new Set([
  "list_dir", "read_file", "search_file", "write_file", "remove_path", "move_path", "copy_path",
  "stat_path", "run_command", "web_search", "fetch_url", "list_processes",
  "kill_process", "start_dev_server", "verify_server", "save_memory",
  "search_memory", "github_repo", "task_manager",
]);

function normalizeIntentTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  const output = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const step = typeof task.step === "string" ? task.step.trim() : "";
    if (!step) continue;
    const tool = typeof task.tool === "string" && KNOWN_TOOL_NAMES.has(task.tool)
      ? task.tool
      : null;
    const args = task.args && typeof task.args === "object" ? task.args : null;
    const dependsOn = typeof task.dependsOn === "number" ? task.dependsOn : null;
    output.push({ step, tool, args, dependsOn, done: false });
    if (output.length >= 6) break;
  }
  return output;
}

async function classifyIntent(userContent, config, providerRegistry = null, roleExecution = null) {
  const endpoint = config?.endpoint || DEFAULT_CONFIG.endpoint;
  const systemPrompt =
    "You are a request router. Classify the user request and plan the tool calls needed.\n" +
    "Respond with ONLY a JSON object. No explanation, no markdown.\n\n" +
    "Fields:\n" +
    '- needsTool (boolean): true if ANY action is needed (file ops, web, commands, memory)\n' +
    "- category (string): chat | filesystem | web | process | other\n" +
    "- tools (string[]): which tools are needed\n" +
    '- tasks (array): step-by-step plan, each object has "step" (string) and "tool" (string)\n\n' +
    "Available tools: list_dir, read_file, search_file, write_file, stat_path, run_command, " +
    "remove_path, move_path, copy_path, web_search, fetch_url, list_processes, " +
    "kill_process, start_dev_server, verify_server, save_memory, search_memory, github_repo.\n\n" +
    "RULES:\n" +
    "- ANY request about files, folders, desktop, directories, code → needsTool: true\n" +
    "- ANY request to edit, create, change, modify, build, recode, redesign a file → needsTool: true, include write_file\n" +
    "- ANY request to look at, find, go into, navigate, list, show → needsTool: true, include list_dir or read_file\n" +
    "- For targeted file checks about whether text, settings, labels, or identifiers exist, prefer search_file before read_file\n" +
    "- For edits: always plan read_file BEFORE write_file\n" +
    '- Only needsTool: false for pure conversation (greetings, questions about general knowledge)\n\n' +
    "Examples:\n" +
    'User: "go into the bank folder on the desktop, find src/page.tsx and recode it as a dashboard"\n' +
    '{"needsTool":true,"category":"filesystem","tools":["list_dir","read_file","write_file"],' +
    '"tasks":[{"step":"List the bank folder on Desktop","tool":"list_dir"},' +
    '{"step":"Read the current page.tsx","tool":"read_file"},' +
    '{"step":"Write the updated dashboard page","tool":"write_file"}]}\n\n' +
    'User: "inspect settings-form.tsx and tell me whether it exposes max tool rounds"\n' +
    '{"needsTool":true,"category":"filesystem","tools":["search_file","read_file"],' +
    '"tasks":[{"step":"Search settings-form.tsx for max tool rounds","tool":"search_file"},' +
    '{"step":"Read the file only if more context is needed","tool":"read_file"}]}\n\n' +
    'User: "what files are on my desktop"\n' +
    '{"needsTool":true,"category":"filesystem","tools":["list_dir"],' +
    '"tasks":[{"step":"List Desktop contents","tool":"list_dir"}]}\n\n' +
    'User: "search the web for next.js tutorials"\n' +
    '{"needsTool":true,"category":"web","tools":["web_search"],' +
    '"tasks":[{"step":"Search for next.js tutorials","tool":"web_search"}]}\n\n' +
    'User: "hello how are you"\n' +
    '{"needsTool":false,"category":"chat","tools":[],"tasks":[]}';
  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.0,
    top_p: 0.1,
    max_tokens: 768,
    stream: false,
    repetition_penalty: 1.0,
  };
  const activeModel =
    roleExecution?.assignment?.model ||
    config?.roleAssignments?.router?.model ||
    config?.modelRoles?.classifier ||
    config?.model;
  if (activeModel) payload.model = activeModel;
  if (config?.statelessProvider) {
    payload.cache_prompt = false;
    payload.n_keep = 0;
    payload.slot_id = -1;
  }

  let data = null;
  if (providerRegistry && roleExecution?.provider?.id) {
    data = await callRoleProviderWithCompat(providerRegistry, roleExecution, payload, {
      compatConfig: config,
      timeout: 25000,
    });
  } else {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      25000
    );

    if (!res.ok) return null;
    data = await res.json();
  }

  const text =
    data?.choices?.[0]?.message?.content ||
    data?.content ||
    "";
  const jsonMatch = extractFirstJsonObject(text);
  if (!jsonMatch) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch);
  } catch {
    return null;
  }

  if (typeof parsed.needsTool !== "boolean" || !parsed.category) return null;

  return {
    needsTool: parsed.needsTool,
    category: String(parsed.category),
    readOnly: typeof parsed.readOnly === "boolean" ? parsed.readOnly : null,
    tools: Array.isArray(parsed.tools) ? parsed.tools.map(String) : [],
    maxRounds: typeof parsed.maxRounds === "number"
      ? Math.max(3, Math.min(20, Math.round(parsed.maxRounds)))
      : null,
    targetPath: typeof parsed.targetPath === "string" ? parsed.targetPath : null,
    tasks: normalizeIntentTasks(parsed.tasks),
    memoryItems: normalizeIntentMemoryItems(parsed.memoryItems),
  };
}

function looksLikeWebLookupRequest(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (/\b(search|look\s*up|google|browse)\s+(the\s+)?(web|internet|online)\b/.test(text)) {
    return true;
  }
  if (
    /\b(?:search|look\s*up|find|check)\b/.test(text) &&
    /\b(?:events?|concerts?|shows?|things to do|weather|forecast|price|prices|news|happening|tonight|today|tomorrow|weekend)\b/.test(text)
  ) {
    return true;
  }
  if (/\b(?:what'?s|what is)\s+happening\b/.test(text)) {
    return true;
  }
  if (
    /\b(?:events?|concerts?|shows?|things to do|happening)\b/.test(text) &&
    /\b(?:today|tonight|tomorrow|this weekend|weekend|near me)\b/.test(text)
  ) {
    return true;
  }
  if (
    /\bwhat\s+can\s+i\s+do\b/.test(text) &&
    /\b(?:today|tonight|tomorrow|this weekend|weekend|near me)\b/.test(text)
  ) {
    return true;
  }
  if (
    /\b(?:recommend|suggest|find)\b/.test(text) &&
    /\b(?:something|somewhere|things?)\s+to\s+do\b/.test(text)
  ) {
    return true;
  }
  if (/https?:\/\//.test(text)) {
    return true;
  }
  if (/\b(latest|current|recent)\b/.test(text) && /\b(version|release|update|news|article|blog|tutorial)\b/.test(text)) {
    return true;
  }
  return false;
}

function isQuickWebAnswerRequest(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (!text.trim()) return false;
  if (/https?:\/\//.test(text)) return false;
  if (
    /\b(?:research|investigate|analysis|analyze|compare|comparison|deep\s+research|full\s+article|full\s+text|read\s+the\s+article|details?|why|how)\b/.test(
      text
    )
  ) {
    return false;
  }

  const hasQuickTopic =
    /\b(?:news|headlines|weather|forecast|price|prices|happening|events?|concerts?|shows?|things to do)\b/.test(
      text
    );
  const hasTimeOrFreshness =
    /\b(?:today|tonight|tomorrow|right now|currently|current|latest|recent|this weekend|weekend)\b/.test(
      text
    );

  return hasQuickTopic || hasTimeOrFreshness;
}

function extractWebSearchSite(userContent) {
  const text = String(userContent || "").trim();
  const match =
    text.match(/\bsite:([a-z0-9.-]+\.[a-z]{2,})\b/i) ||
    text.match(/\b(?:on|from|within)\s+([a-z0-9.-]+\.[a-z]{2,})\b/i);
  return match ? match[1].toLowerCase() : "";
}

function buildWebSearchQuery(userContent) {
  let text = String(userContent || "").trim();
  if (!text) return "";

  text = text.replace(/\bsite:[^\s]+\b/gi, " ");
  text = text.replace(/\b(?:on|from|within)\s+[a-z0-9.-]+\.[a-z]{2,}\b/gi, " ");
  text = text.replace(/^[\s,]*(?:can|could|would|will)\s+you\s+/i, "");
  text = text.replace(/^[\s,]*please\s+/i, "");
  text = text.replace(/^[\s,]*(?:i need you to|help me)\s+/i, "");
  text = text.replace(/\b(?:look\s*up|search(?:\s+for)?|find|check)\b\s*/i, "");
  text = text.replace(/\b(?:tell me|show me)\b\s*/i, "");
  text = text.replace(/\bif there (?:are|is) any\b/i, "");
  text = text.replace(/\b(?:are|is) there any\b/i, "");
  text = text.replace(/\?+$/, "");
  text = text.replace(/\s+/g, " ").trim();

  return text || String(userContent || "").trim();
}

function inferWebSearchLimit(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (/\b(?:today|tonight|tomorrow|this weekend|weekend|right now|currently)\b/.test(text)) {
    return 3;
  }
  if (/\b(?:events?|concerts?|shows?|things to do|weather|forecast|price|prices|news|happening)\b/.test(text)) {
    return 3;
  }
  return 5;
}

function inferProjectDirectory(userContent, config) {
  const text = String(userContent || "");
  const home = config.homeDir || os.homedir();
  const desktop = config.desktopDir || path.join(home, "Desktop");
  const workspaceRoot = config.workspaceRoot || home;

  const desktopPathMatch = text.match(/desktop\/([a-zA-Z0-9._-]+)/i);
  if (desktopPathMatch) {
    return path.join(desktop, desktopPathMatch[1]);
  }

  const folderMatch =
    text.match(/(?:inside|in)\s+the\s+([a-zA-Z0-9._-]+)\s+folder(?:\s+on\s+the\s+desktop)?/i) ||
    text.match(/\b([a-zA-Z0-9._-]+)\s+folder\s+on\s+the\s+desktop\b/i);
  if (folderMatch) {
    return path.join(desktop, folderMatch[1]);
  }

  const absoluteishMatch = text.match(/([~/.][^\s]+)/);
  if (absoluteishMatch) {
    const raw = absoluteishMatch[1];
    if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
    if (raw.startsWith("./")) return path.join(workspaceRoot, raw.slice(2));
    if (raw.startsWith("/")) return raw;
  }

  return "";
}

function inferRecentProjectDirectory(history, config) {
  const home = config.homeDir || os.homedir();
  const desktop = config.desktopDir || path.join(home, "Desktop");
  const recent = Array.isArray(history) ? [...history].slice(-10).reverse() : [];
  for (const entry of recent) {
    const text = String(entry?.content || "");
    const directDesktopMatch = text.match(/Desktop\/([a-zA-Z0-9._-]+)/i);
    if (directDesktopMatch) {
      return path.join(desktop, directDesktopMatch[1]);
    }
    const namedFolderMatch =
      text.match(/folder named ["“]?([a-zA-Z0-9._-]+)["”]?/i) ||
      text.match(/new folder ["“]?([a-zA-Z0-9._-]+)["”]?/i) ||
      text.match(/project folder ["“]?([a-zA-Z0-9._-]+)["”]?/i);
    if (namedFolderMatch) {
      return path.join(desktop, namedFolderMatch[1]);
    }
  }
  return "";
}

function inferRecentFilesystemTarget(history, config) {
  const recent = Array.isArray(history) ? [...history].slice(-12).reverse() : [];
  const recentProjectDir = inferRecentProjectDirectory(history, config);
  for (const entry of recent) {
    if (entry?.role !== "user") continue;
    const target = inferFilesystemTarget(String(entry?.content || ""), {
      homeDir: config.homeDir || os.homedir(),
      desktopDir: config.desktopDir || path.join(config.homeDir || os.homedir(), "Desktop"),
      workspaceRoot: config.workspaceRoot || (config.homeDir || os.homedir()),
      fallbackDir: recentProjectDir || config.workspaceRoot || config.homeDir || os.homedir(),
    });
    if (target?.path) return target;
  }
  return null;
}

function inferServerStartCommand(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (text.includes("pnpm")) return "pnpm dev";
  if (text.includes("yarn")) return "yarn dev";
  if (text.includes("bun")) return "bun run dev";
  if (text.includes("npm run start")) return "npm run start";
  return "npm run dev";
}

function inferScaffoldPreset(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (/\bnext(?:\.js|js)?\b/.test(text) && /\bshadcn\b/.test(text)) {
    return "nextjs-shadcn";
  }
  if (/\belectron\b/.test(text)) {
    return "electron-forge-vite-ts";
  }
  if (/\bexpo\b/.test(text) || /\breact[-\s]?native\b/.test(text)) {
    return "expo-default";
  }
  if (/\bfast\s*api\b/.test(text) || /\bfastapi\b/.test(text)) {
    return "fastapi-uv";
  }
  if (/\bpython\b/.test(text) && /\buv\b/.test(text)) {
    return /\bpackage\b|\blibrary\b|\blib\b/.test(text)
      ? "python-uv-package"
      : "python-uv-app";
  }
  if (/\bvite\b/.test(text) && /\bvue\b/.test(text)) {
    return "vite-vue-ts";
  }
  if (/\bvite\b/.test(text) && /\bvanilla\b/.test(text)) {
    return "vite-vanilla-ts";
  }
  if (/\bvite\b/.test(text)) {
    return "vite-react-ts";
  }
  return "";
}

function inspectToolLoopMessages(messages) {
  const toolByCallId = new Map();
  const usedNames = [];
  const lastResultByName = new Map();
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        const name = toolCall?.function?.name;
        const id = toolCall?.id;
        if (!name || !id) continue;
        let args = {};
        try {
          args =
            typeof toolCall?.function?.arguments === "string"
              ? JSON.parse(toolCall.function.arguments)
              : toolCall?.function?.arguments || {};
        } catch {
          args = {};
        }
        toolByCallId.set(id, {
          id,
          name,
          args,
          result: null,
        });
        usedNames.push(name);
      }
      continue;
    }
    if (msg?.role === "tool" && msg.tool_call_id) {
      const call = toolByCallId.get(msg.tool_call_id);
      if (!call?.name) continue;
      let parsedResult = {};
      try {
        parsedResult = JSON.parse(msg.content || "{}");
      } catch {
        parsedResult = {};
      }
      call.result = parsedResult;
      lastResultByName.set(call.name, parsedResult);
    }
  }
  const usedCalls = Array.from(toolByCallId.values());
  return {
    usedNames,
    usedCalls,
    hasUsed(name) {
      return usedNames.includes(name);
    },
    hasUsedCall(predicate) {
      if (typeof predicate !== "function") return false;
      return usedCalls.some((call) => predicate(call));
    },
    lastResult(name) {
      return lastResultByName.get(name);
    },
    lastCall(name) {
      for (let i = usedCalls.length - 1; i >= 0; i -= 1) {
        if (usedCalls[i]?.name === name) return usedCalls[i];
      }
      return null;
    },
  };
}

function extractTargetLookupTerms(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];

  const quoted = Array.from(
    source.matchAll(/["'`“”]([^"'`“”\n]{2,80})["'`“”]/g)
  )
    .map((match) => (match[1] || "").trim())
    .filter(Boolean);
  if (quoted.length > 0) {
    return [...new Set(quoted)].slice(0, 6);
  }

  const match = source.match(
    /\b(?:contains?|contain|mentions?|exposes?|includes?|has)\b\s+(.+?)(?:[.?!]|$)/i
  );
  if (!match?.[1]) return [];

  return [...new Set(
    match[1]
      .replace(/^(?:whether|if)\s+/i, "")
      .split(/\s*,\s*|\s+and\s+/i)
      .map((part) => part.trim().replace(/^[`"'“”]+|[`"'“”]+$/g, ""))
      .map((part) => part.replace(/^(?:the|a|an)\s+/i, "").trim())
      .filter((part) => part.length >= 3)
  )].slice(0, 6);
}

function looksLikeFilesystemMutationCommand(command) {
  const token = ` ${String(command || "").toLowerCase()} `;
  return (
    token.includes(" rm ") ||
    token.includes(" mv ") ||
    token.includes(" cp ") ||
    token.includes(" mkdir ") ||
    token.includes(" rmdir ") ||
    token.includes(" touch ") ||
    token.includes(" >") ||
    token.includes(">>") ||
    token.includes(" sed -i") ||
    token.includes(" perl -i") ||
    token.includes(" truncate ") ||
    token.includes(" tee ")
  );
}

function hasAppliedFilesystemMutation(messages) {
  const loopState = inspectToolLoopMessages(messages);
  return loopState.usedCalls.some((call) => {
    if (!call?.name) return false;
    if (["write_file", "remove_path", "move_path", "copy_path"].includes(call.name)) {
      return true;
    }
    if (call.name === "run_command") {
      return looksLikeFilesystemMutationCommand(call.args?.command);
    }
    return false;
  });
}

function buildServerCompletionGuard(userContent) {
  const localMachineTask = classifyLocalMachineInfoTask(userContent);
  if (localMachineTask) {
    return ({ payload }) => {
      const loopState = inspectToolLoopMessages(payload?.messages || []);
      const missing = [];
      if (
        localMachineTask.wantsLocalIp &&
        !loopState.hasUsedCall(
          (call) =>
            call?.name === "run_command" &&
            matchesCommandHint(call?.args?.command, "hostname -i")
        )
      ) {
        missing.push("the local IP");
      }
      if (
        localMachineTask.wantsTailscaleIp &&
        !loopState.hasUsedCall(
          (call) =>
            call?.name === "run_command" &&
            matchesCommandHint(call?.args?.command, TAILSCALE_IPV4_COMMAND)
        )
      ) {
        missing.push("the Tailscale IP");
      }
      if (
        localMachineTask.wantsHostname &&
        !loopState.hasUsedCall(
          (call) =>
            call?.name === "run_command" &&
            matchesCommandHint(call?.args?.command, HOSTNAME_COMMAND, {
              exact: true,
            })
        )
      ) {
        missing.push("the hostname");
      }
      if (missing.length === 0) return null;
      return {
        block: true,
        phase: "execute",
        note:
          `[System note] You still need to gather ${missing.join(" and ")}. ` +
          "Call the next tool now before the final response.",
      };
    };
  }

  const task = classifyProcessTask(userContent);
  if (!task) return null;
  const expectedHost = task.host;
  const expectedPort = task.port;
  return ({ payload }) => {
    const loopState = inspectToolLoopMessages(payload?.messages || []);
    if (task.intent === "stop") {
      const scan = loopState.lastResult("list_processes");
      const verifiedStopped =
        scan &&
        Number(scan.port) === Number(expectedPort) &&
        Number(scan.count) === 0;
      if (verifiedStopped) return null;
      return {
        block: true,
        phase: "verify_stopped",
        note:
          `[System note] The task is not done until list_processes confirms port ` +
          `${expectedPort} is free.`,
      };
    }
    const verification = loopState.lastResult("verify_server");
    const verifiedUp =
      verification &&
      verification.ok === true &&
      Number(verification.port) === Number(expectedPort) &&
      String(verification.host || expectedHost) === String(expectedHost);
    if (verifiedUp) return null;
    return {
      block: true,
      phase: "verify",
      note:
        `[System note] The task is not done until verify_server succeeds for ` +
        `${expectedHost}:${expectedPort}. Use tools and verify before final response.`,
    };
  };
}

function describeToolProgress(name, args, result, phase = "running") {
  if (name === "scaffold_project") {
    if (phase === "running") {
      return `Scaffolding ${args?.preset || "project"} in ${args?.projectPath || "target folder"}`;
    }
    return result?.ok
      ? `Project scaffolded in ${result.projectPath || args?.projectPath || "target folder"}`
      : "Project scaffold failed";
  }
  if (name === "scaffold_next_shadcn_project") {
    if (phase === "running") {
      return `Scaffolding Next.js + shadcn project in ${args?.projectPath || "target folder"}`;
    }
    return result?.ok
      ? `Project scaffolded in ${result.projectPath || args?.projectPath || "target folder"}`
      : "Project scaffold failed";
  }
  if (name === "list_processes") {
    if (phase === "running") {
      return args?.port
        ? `Inspecting processes on port ${args.port}`
        : "Inspecting running processes";
    }
    return result?.count > 0
      ? `Found ${result.count} matching process${result.count === 1 ? "" : "es"}`
      : "No matching processes found";
  }
  if (name === "kill_process") {
    if (phase === "running") {
      return args?.port
        ? `Stopping processes on port ${args.port}`
        : `Stopping process ${args?.pid || ""}`.trim();
    }
    return result?.killed ? "Processes stopped" : "No process was stopped";
  }
  if (name === "start_dev_server") {
    if (phase === "running") {
      return `Starting local server on ${args?.host || "0.0.0.0"}:${args?.port || 3000}`;
    }
    return result?.started
      ? `Local server started on ${result.host || args?.host || "0.0.0.0"}:${result.port || args?.port || 3000}`
      : "Local server failed to start";
  }
  if (name === "verify_server") {
    if (phase === "running") {
      return `Verifying local server on ${args?.host || "127.0.0.1"}:${args?.port || 3000}`;
    }
    return result?.ok
      ? `Verified local server on ${result.host || args?.host || "127.0.0.1"}:${result.port || args?.port || 3000}`
      : `Server verification failed on ${result?.host || args?.host || "127.0.0.1"}:${result?.port || args?.port || 3000}`;
  }
  if (name === "web_search") {
    if (phase === "running") {
      return "Searching the web";
    }
    return result?.count > 0 ? `Found ${result.count} web results` : "No web results found";
  }
  if (name === "fetch_url") {
    if (phase === "running") {
      return "Fetching page text";
    }
    return result?.error ? "Failed to fetch page text" : "Fetched page text";
  }
  return phase === "running" ? `Tool: ${name} (running)` : `Tool: ${name} (${phase})`;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleChatProcess(req, res) {
  let activeConversationId = "";
  let workflowOptions = normalizeWorkflowOptions(null);
  let failureRoleId = "default";
  let failureProviderId = "";
  try {
    const body = await readJsonBody(req);
    workflowOptions = normalizeWorkflowOptions(body.workflow);
    const validation = validateChatRequest(body);
    if (!validation.ok) {
      const payload = { error: validation.errors.join(", ") };
      sendJson(res, 400, payload);
      return payload;
    }
    const { conversationId, content: userContent } = validation.data;
    activeConversationId = conversationId;
    await logEvent("chat_request", {
      conversationId,
      content: userContent,
    });
    if (workflowOptions.disableOrchestration && !workflowOptions.persistUserMessage) {
      updateChatProgress(conversationId, "running", "Workflow stage request queued", {
        kind: "workflow",
        phase: "queued",
      });
    } else {
      beginChatProgress(conversationId, "Queued request", {
        kind: "system",
      });
    }

    const baseConfig = await loadConfig(sanitizeConfigInput(body.config));
    const providerRegistry = buildProviderRegistry(baseConfig);
    fsPolicy.unrestrictedShell = Boolean(baseConfig.unrestrictedShell);

    const routerExecution = resolveRoleExecution(
      baseConfig,
      providerRegistry,
      "router"
    );
    let routeResult = null;
    if (workflowOptions.forcedRole) {
      routeResult = {
        role: workflowOptions.forcedRole,
        reason: "forced workflow role",
        source: "workflow",
      };
    } else {
      try {
        routeResult = await routeRequest(
          userContent,
          (payload) =>
            callRoleProviderWithCompat(providerRegistry, routerExecution, payload, {
              compatConfig: baseConfig,
              timeout: 20000,
              sessionId: `${conversationId}:router`,
            }),
          { fallbackRole: "default" }
        );
      } catch (error) {
        routeResult = {
          ...regexRouteFallback(userContent),
          reason: error instanceof Error ? error.message : "routing failed",
          source: "fallback",
        };
      }
    }

    let roleExecution = resolveRoleExecution(
      baseConfig,
      providerRegistry,
      routeResult?.role || "default"
    );
    failureRoleId = roleExecution.roleId || "default";
    failureProviderId = roleExecution.provider?.id || "";
    const config = buildRoleScopedConfig(baseConfig, roleExecution);
    const activeRole = roleExecution.roleId;
    const activeRoleConfig = roleExecution.role;
    updateChatProgress(
      conversationId,
      "running",
      `Routing to ${activeRoleConfig.name}`,
      {
        kind: "routing",
        phase: "done",
        role: activeRole,
        providerId: roleExecution.provider?.id || "",
      }
    );
    await logEvent("role_routed", {
      conversationId,
      role: activeRole,
      reason: routeResult?.reason || "",
      source: routeResult?.source || "fallback",
      providerId: roleExecution.provider?.id || "",
      model: roleExecution.assignment?.model || "",
    });

    // Load conversation history from disk
    const history = await loadConversationMessages(conversationId);

    // Append user message to conversation file
    if (workflowOptions.persistUserMessage) {
      await appendToConversation(conversationId, "user", userContent);
    }

    if (shouldRunChainedWorkflow(activeRole, userContent, workflowOptions)) {
      const workflowPayload = await runChainedWorkflow({
        conversationId,
        userContent,
        body,
        initialRole: activeRole,
      });
      sendJson(res, 200, workflowPayload);
      return workflowPayload;
    }
    if (!workflowOptions.disableOrchestration && activeRole !== "default") {
      const workflowPayload = await runRoleAndSummarizeWorkflow({
        conversationId,
        userContent,
        body,
        roleId: activeRole,
      });
      sendJson(res, 200, workflowPayload);
      return workflowPayload;
    }

    // LLM-based intent classification (fast pre-pass, regex fallback on failure)
    let llmIntent = null;
    if (!workflowOptions.noTools) {
      try {
        llmIntent = await classifyIntent(
          userContent,
          buildRoleScopedConfig(baseConfig, routerExecution),
          providerRegistry,
          routerExecution
        );
      } catch (err) {
        await logEvent("classify_intent_error", {
          conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build context with structured summary compression
    updateChatProgress(conversationId, "running", "Preparing context", {
      kind: "system",
    });
    const summaryState = await loadConversationSummary(conversationId);
    const keepMessages = SUMMARY_KEEP_MESSAGES;
    const recentMessages =
      history.length > keepMessages ? history.slice(-keepMessages) : history;
    const olderMessages =
      history.length > keepMessages ? history.slice(0, -keepMessages) : [];
    const lastSummarizedTs = summaryState?.uptoTs;
    const newForSummary = lastSummarizedTs
      ? olderMessages.filter((m) => m.ts && Date.parse(m.ts) > Date.parse(lastSummarizedTs))
      : olderMessages;
    let summaryText = summaryState?.summary || "";
    let pendingSummary = null;
    if (newForSummary.length >= SUMMARY_MIN_MESSAGES) {
      pendingSummary = {
        config,
        existingSummary: summaryText,
        messages: newForSummary,
        conversationId,
      };
    }

    let contextMessages = recentMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (workflowOptions.contextMessage) {
      contextMessages.push({
        role: "system",
        content: `[Workflow context]\n${workflowOptions.contextMessage}`,
      });
    }
    contextMessages.push({ role: "user", content: userContent });
    if (summaryText) {
      contextMessages.unshift({
        role: "user",
        content:
          `[Conversation summary — do not respond to this, it is context only]\n${summaryText}`,
      });
    }

    // Character budget: trim oldest recent messages if total exceeds limit
    let totalChars = contextMessages.reduce(
      (sum, m) => sum + (m.content?.length || 0),
      0
    );
    const contextCharBudget =
      typeof config.contextCharBudget === "number"
        ? config.contextCharBudget
        : CONTEXT_CHAR_BUDGET;
    while (totalChars > contextCharBudget && contextMessages.length > 2) {
      const removed = contextMessages[summaryText ? 1 : 0];
      if (!removed) break;
      contextMessages.splice(summaryText ? 1 : 0, 1);
      totalChars -= (removed.content?.length || 0);
    }

    // Build system prompt
    const [corePrompt, userMd, soulMd, skillsSummary] = await Promise.all([
      readText(PATHS.core, DEFAULT_CORE_PROMPT),
      readText(PATHS.user, ""),
      readText(PATHS.soul, ""),
      loadSkillsSummary(),
    ]);

    _chatRequestCount += 1;
    if (_chatRequestCount % MEMORY_MAINTENANCE_INTERVAL === 1) {
      await rehashEmbeddingsIfNeeded();
      await pruneMemorySummaries();
      await consolidateMemoryStore();
      await decayMemories();
      await compressOldMemories();
    }
    let memories = await loadAllMemories();
    const invalidations = detectMemoryInvalidations(userContent, memories);
    if (invalidations.length > 0) {
      await markMemoriesInvalid(invalidations);
    }
    const candidates = detectMemoryCandidates(userContent, memories, 5);
    const createdMemories = [];
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        const created = await createMemory(
          candidate.content,
          candidate.tags,
          {
            kind: "user_message",
            conversationId,
            messageTs: new Date().toISOString(),
          },
          { type: candidate.type, confidence: candidate.confidence, confirmed: false, approved: true }
        );
        if (created?.saved) createdMemories.push(created);
      }
    }
    if (invalidations.length > 0) {
      const invalidationSet = new Set(invalidations);
      const now = new Date().toISOString();
      for (const mem of memories) {
        if (invalidationSet.has(mem.id)) {
          mem.confirmed = false;
          mem.invalidatedAt = now;
        }
      }
    }
    if (createdMemories.length > 0) {
      memories = memories.concat(createdMemories);
    }
    const intentMemoryItems = normalizeIntentMemoryItems(llmIntent?.memoryItems).filter(
      (item) => !isMemoryAlreadyKnown(item.content, memories)
    );
    const getPendingIntentMemoryItems = (messages = []) => {
      const loopState = inspectToolLoopMessages(messages);
      return intentMemoryItems.filter(
        (item) =>
          !loopState.hasUsedCall((call) => {
            if (!["save_memory", "update_memory"].includes(call?.name)) return false;
            return (
              normalizeMemoryContent(call?.args?.content).toLowerCase() ===
              normalizeMemoryContent(item.content).toLowerCase()
            );
          })
      );
    };

    const recentContext = history
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join(" ");
    const combinedQuery = [recentContext, userContent].filter(Boolean).join(" ");

    const usableMemories = memories.filter(
      (m) =>
        !(Array.isArray(m?.tags) && m.tags.includes("summary")) &&
        m?.source?.kind !== "auto_summary"
    );
    const isShortFollowUp = userContent.trim().length < 20 && history.length > 2;
    const relevantMemoryLimit = inferRelevantMemoryLimit(
      usableMemories,
      combinedQuery,
      5,
      10,
      {
        minScore: isShortFollowUp ? 0 : 1,
        referenceMaxAgeDays: 45,
        maxAgeDays: 180,
      }
    );
    const selectedMemories = selectMemoriesWithFallback(usableMemories, combinedQuery, relevantMemoryLimit, {
      maxPinned: 2,
      maxAgeDays: 180,
      referenceMaxAgeDays: 45,
      minScore: isShortFollowUp ? 0 : 1,
    });
    const relevantMemories = guaranteeMinMemories(selectedMemories, usableMemories, 2);
    await markMemoriesUsed(relevantMemories.map((m) => m.id));
    const githubLine =
      config?.githubUsername && config?.githubToken
        ? `GitHub: ${config.githubUsername} (use github_repo)`
        : "";
    const workspaceSummary = config?.workspaceRoot
      ? [
          "[Workspace]",
          `root: ${config.workspaceRoot}`,
          `desktop: ${config.desktopDir || path.join(config.workspaceRoot, "Desktop")}`,
          `active_role: ${activeRole}`,
          `active_provider: ${roleExecution.provider?.name || roleExecution.provider?.id || config.provider}`,
          `active_model: ${config.model || ""}`,
          githubLine,
          `shell_access: ${config.unrestrictedShell ? "unrestricted" : "guarded"}`,
          `web_search: ${config.webSearchEnabled ? "enabled" : "disabled"}`,
          "Use tools for file ops. Resolve relative paths from root.",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

    const baseSystemMessage = buildSystemPrompt({
      corePrompt,
      userMd,
      soulMd,
      skillsSummary: config.lightweightMode ? "" : skillsSummary,
      workspaceSummary,
      memories: relevantMemories,
      maxMemoryItems: config.maxMemoryItems,
      maxMemoryChars: config.maxMemoryChars,
    });
    const systemMessage = [
      buildRoleContractPrompt(activeRole),
      activeRoleConfig.systemPromptPrefix || "",
      baseSystemMessage,
    ]
      .filter(Boolean)
      .join("\n\n");

    const isWebLookup = Boolean(config.webSearchEnabled) && looksLikeWebLookupRequest(userContent);
    const processTask = classifyProcessTask(userContent);
    const localMachineTask = classifyLocalMachineInfoTask(userContent);
    const explicitProjectDir = inferProjectDirectory(userContent, config);
    const recentProjectDir = inferRecentProjectDirectory(history, config);
    const recentFilesystemTarget = inferRecentFilesystemTarget(history, config);
    const currentFilesystemTarget = inferFilesystemTarget(userContent, {
      homeDir: config.homeDir || os.homedir(),
      desktopDir: config.desktopDir || path.join(config.homeDir || os.homedir(), "Desktop"),
      workspaceRoot: config.workspaceRoot || (config.homeDir || os.homedir()),
      fallbackDir: explicitProjectDir || recentProjectDir || config.workspaceRoot || config.homeDir || os.homedir(),
    });
    const explicitFileReference = extractBareFileReference(userContent);
    const referentialFilesystemFollowUp =
      looksLikeReferentialFilesystemFollowUp(userContent) &&
      Boolean(recentFilesystemTarget?.path);
    const editLikeRequest = looksLikeEditRequest(userContent);
    const editTargetPath =
      (currentFilesystemTarget?.kind === "file" ? currentFilesystemTarget.path : "") ||
      (referentialFilesystemFollowUp && recentFilesystemTarget?.kind === "file"
        ? recentFilesystemTarget.path
        : "") ||
      (explicitFileReference
        ? path.join(
            explicitProjectDir || recentProjectDir || config.workspaceRoot || config.homeDir || os.homedir(),
            explicitFileReference
          )
        : "");

    const requiresTool = (() => {
      if (workflowOptions.noTools) return false;
      if (intentMemoryItems.length > 0) return true;
      if (llmIntent) return llmIntent.needsTool;
      const text = userContent.toLowerCase();
      // Direct shell commands — always require a tool
      if (/\b(?:ls|cat|mkdir|rmdir|pwd|cd)\b/.test(text)) return true;
      // Explicit file/directory operations with filesystem context
      if (/\b(?:read|open|write|save)\s+(?:the\s+)?(?:file|document)\b/.test(text)) return true;
      if (/\b(?:list|show|what'?s?\s+in)\s+(?:the\s+)?(?:folder|directory|desktop|home)\b/.test(text)) return true;
      if (/\b(?:create|make)\s+(?:a\s+)?(?:file|folder|directory)\b/.test(text)) return true;
      if (/\b(?:delete|remove)\s+(?:the\s+)?(?:file|folder|directory)\b/.test(text)) return true;
      if (/\b(?:move|rename|copy)\s+(?:the\s+)?(?:file|folder|directory)\b/.test(text)) return true;
      if (/\b(?:run|execute)\s+(?:the\s+)?(?:command|script|bash|shell)\b/.test(text)) return true;
      if (/\b(?:inspect|explore|scan|review|look\s+through|go\s+through|find|go\s+into|navigate\s+to)\b/.test(text) && /\b(?:file|files|folder|directory|project|repo|repository|codebase|source|structure|src)\b/.test(text)) return true;
      if (/\b(?:see|understand|inspect|explore)\s+(?:how\s+(?:you|it)\s+work|yourself|your\s+own\s+(?:files|code|project|repo|repository|structure))\b/.test(text)) return true;
      if (/\bfile\s+structure\b/.test(text)) return true;
      if (/\b(?:desktop|home)\b/.test(text) && /\b(?:go\s+(?:to|into)|open|list|show|read|find|navigate|what'?s?\s+in)\b/.test(text)) return true;
      if (looksLikeEditRequest(userContent) && Boolean(extractBareFileReference(userContent))) return true;
      if (referentialFilesystemFollowUp) return true;
      if (currentFilesystemTarget?.path && /\b(?:open|read|show|list|view|edit|change|modify|update|replace)\b/.test(text)) return true;
      if (localMachineTask) return true;
      if (processTask) return true;
      if (/\b(?:create|build|scaffold|set\s*up|initialize|init)\s+(?:a\s+)?(?:new\s+)?(?:project|app|application|website|site|repo|repository)\b/.test(text)) return true;
      if (/\b(?:install|add|remove|uninstall)\s+\w/.test(text) && /\b(?:package|dependency|dep|lib|library|module|shadcn|tailwind|prisma|next|react|vue|express)\b/.test(text)) return true;
      if (/\b(?:fix|update|change|modify|edit|refactor|debug|recode|redesign|rebuild|rework|redo|restyle|revamp|overhaul|rewrite|transform)\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:code|bug|error|issue|style|styling|layout|page|component|function|api|route|config|file|dashboard|ui|view|screen)\b/.test(text)) return true;
      if (/\b(?:add|create|implement|build)\s+(?:a\s+|an\s+|the\s+)?(?:page|component|feature|form|button|modal|sidebar|navbar|header|footer|api|route|endpoint|test)\b/.test(text)) return true;
      if (/\b(?:show|check|review)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current)\s+(?:changes|status)\b/.test(text)) return true;
      if (/\b(?:deploy|push|publish|upload|host)\b/.test(text)) return true;
      if (/\bnpx?\s+\w/.test(text)) return true;
      if (isWebLookup) return true;
      // Path-like patterns (e.g., "/home/user/file.txt", "~/Desktop", "./src")
      if (/(?:^|\s)[~.]?\/\w/.test(text)) return true;
      // File reference with any action verb — "recode that page.tsx", "go into the page.tsx"
      if (extractBareFileReference(userContent) && /\b(?:go|find|recode|redesign|make|look|create|build|write|edit|update|change|modify|open|read|fix|style|add|remove|delete|check)\b/.test(text)) return true;
      return false;
    })();

    const isGitRequest = (() => {
      if (Array.isArray(llmIntent?.tools) && llmIntent.tools.includes("github_repo")) {
        return true;
      }
      const text = userContent.toLowerCase();
      return /\b(git|github|repo|repository|commit|push|pull|clone|branch)\b/.test(
        text
      );
    })();

    const isReadOnlyFsRequest = (() => {
      if (llmIntent && llmIntent.readOnly != null) return llmIntent.readOnly;
      const text = userContent.toLowerCase();
      const readish =
        /\b(?:list|show|what'?s?\s+in|whats?\s+in|read|open|view|stat|exists|inspect|explore|scan|review|look\s+through|go\s+through)\b/.test(
          text
        );
      const writeish =
        /\b(?:create|make|write|save|delete|remove|move|rename|copy|mkdir|rmdir|touch)\b/.test(
          text
        );
      return readish && !writeish;
    })();
    const isPureWebLookup = llmIntent
      ? llmIntent.category === "web"
      : isWebLookup &&
        !processTask &&
        !isGitRequest &&
        !/\b(?:file|folder|directory|desktop|home|terminal|shell|command|script|git|repo|repository|server|port)\b/.test(
          userContent.toLowerCase()
        );
    const isQuickWebAnswer = isPureWebLookup && isQuickWebAnswerRequest(userContent);

    const fallbackToolCall = async (_message, _payload, options = {}) => {
      if (!requiresTool) return null;
      const text = userContent.toLowerCase();
      const home = config.homeDir || os.homedir();
      const desktop = config.desktopDir || path.join(home, "Desktop");
      const phase = options?.phase || "execute";
      const pendingIntentMemoryItems = getPendingIntentMemoryItems(_payload?.messages || []);

      const wantsDesktop = text.includes("desktop");
      const wantsHome = /\bhome\b/.test(text);
      const wantsWorkspace =
        /\b(?:project|repo|repository|codebase|source|structure|how you work|yourself|your own)\b/.test(
          text
        );
      const scaffoldNextApp =
        /\b(?:next(?:\.js|js)?|shadcn)\b/.test(text) &&
        /\b(?:create|make|build|scaffold|set\s*up|initialize|init|bootstrap)\b/.test(
          text
        ) &&
        /\b(?:project|app|application|site|website|folder)\b/.test(text);
      const scaffoldPreset = inferScaffoldPreset(userContent);
      const scaffoldGenericApp =
        Boolean(scaffoldPreset) &&
        /\b(?:create|make|build|scaffold|set\s*up|initialize|init|bootstrap)\b/.test(
          text
        ) &&
        /\b(?:project|app|application|site|website|folder|workspace|repo|repository)\b/.test(
          text
        );
      const listLike =
        text.includes("list") ||
        text.includes("what's in") ||
        text.includes("whats in") ||
        /\b(?:inspect|explore|scan|review|look through|go through|file structure)\b/.test(text) ||
        (text.includes("show") && /\b(?:folder|directory|desktop|home|files?|project|repo|repository)\b/.test(text));
      const readLike =
        text.includes("read") ||
        text.includes("open") ||
        /\b(?:inspect|explore|review|look through|go through)\b/.test(text);
      const makeDirLike =
        text.includes("mkdir") ||
        text.includes("make folder") ||
        text.includes("create folder") ||
        text.includes("create directory") ||
        text.includes("make directory");
      const editLike = looksLikeEditRequest(userContent);
      const deleteLike =
        text.includes("delete") || text.includes("remove") || text.includes("rm ");
      const moveLike =
        text.includes("move") || text.includes("rename") || text.includes("mv ");
      const copyLike = text.includes("copy") || text.includes("cp ");
      const repoStatusLike =
        /\b(?:show|check|review)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current)\s+(?:changes|status)\b/.test(text) ||
        /\bgit\s+(?:status|diff|log)\b/.test(text);
      const referentialTarget =
        looksLikeReferentialFilesystemFollowUp(userContent) ? recentFilesystemTarget : null;

      if (localMachineTask) {
        const loopState = inspectToolLoopMessages(_payload?.messages || []);
        if (
          localMachineTask.wantsLocalIp &&
          !loopState.hasUsedCall(
            (call) =>
              call?.name === "run_command" &&
              matchesCommandHint(call?.args?.command, "hostname -i")
          )
        ) {
          return {
            name: "run_command",
            arguments: {
              command: LOCAL_IP_COMMAND,
            },
          };
        }
        if (
          localMachineTask.wantsTailscaleIp &&
          !loopState.hasUsedCall(
            (call) =>
              call?.name === "run_command" &&
              matchesCommandHint(call?.args?.command, TAILSCALE_IPV4_COMMAND)
          )
        ) {
          return {
            name: "run_command",
            arguments: {
              command: TAILSCALE_IPV4_COMMAND,
            },
          };
        }
        if (
          localMachineTask.wantsHostname &&
          !loopState.hasUsedCall(
            (call) =>
              call?.name === "run_command" &&
              matchesCommandHint(call?.args?.command, HOSTNAME_COMMAND, {
                exact: true,
              })
          )
        ) {
          return {
            name: "run_command",
            arguments: {
              command: HOSTNAME_COMMAND,
            },
          };
        }
        return null;
      }

      if (phase === "save_memory" && pendingIntentMemoryItems.length > 0) {
        const nextMemory = pendingIntentMemoryItems[0];
        return {
          name: "save_memory",
          arguments: {
            content: nextMemory.content,
            type: nextMemory.type,
            tags: nextMemory.tags,
            confirmed: true,
            approved: true,
            confidence: 1,
          },
        };
      }

      if (isWebLookup) {
        const urlMatch = userContent.match(/https?:\/\/[^\s)]+/i);
        if (urlMatch) {
          return {
            name: "fetch_url",
            arguments: {
              url: urlMatch[0],
              maxChars: 6000,
            },
          };
        }
        return {
          name: "web_search",
          arguments: {
            query: buildWebSearchQuery(userContent),
            limit: inferWebSearchLimit(userContent),
            site: extractWebSearchSite(userContent) || undefined,
          },
        };
      }

      if (scaffoldGenericApp) {
        return {
          name: "scaffold_project",
          arguments: {
            projectPath:
              explicitProjectDir ||
              recentProjectDir ||
              path.join(desktop, "ember-project"),
            preset: scaffoldPreset,
            packageManager: "npm",
          },
        };
      }

      if (scaffoldNextApp) {
        return {
          name: "scaffold_next_shadcn_project",
          arguments: {
            projectPath:
              explicitProjectDir ||
              recentProjectDir ||
              path.join(desktop, "ember-next-app"),
            packageManager: "npm",
          },
        };
      }

      if (processTask) {
        const cwd = explicitProjectDir || recentProjectDir;
        const { host, port, intent } = processTask;
        const loopState = inspectToolLoopMessages(_payload?.messages || []);
        const projectManifest = cwd ? await loadEmberProjectManifest(cwd) : null;
        if (phase === "verify" && intent !== "stop") {
          return {
            name: "verify_server",
            arguments: {
              host,
              port,
              path: "/",
              timeoutMs: 15000,
            },
          };
        }
        if (phase === "verify_stopped" || intent === "stop") {
          return {
            name: "list_processes",
            arguments: {
              port,
              limit: 10,
            },
          };
        }
        if (!loopState.hasUsed("list_processes")) {
          return {
            name: "list_processes",
            arguments: {
              port,
              limit: 10,
            },
          };
        }
        const lastProcessScan = loopState.lastResult("list_processes");
        if ((lastProcessScan?.count || 0) > 0 && !loopState.hasUsed("kill_process")) {
          return {
            name: "kill_process",
            arguments: {
              port,
            },
          };
        }
        if (intent === "stop") {
          return {
            name: "list_processes",
            arguments: {
              port,
              limit: 10,
            },
          };
        }
        if (!loopState.hasUsed("start_dev_server")) {
          return {
            name: "start_dev_server",
            arguments: {
              cwd: cwd || desktop,
              command:
                typeof projectManifest?.startCommand === "string" &&
                projectManifest.startCommand.trim()
                  ? projectManifest.startCommand.trim()
                  : inferServerStartCommand(userContent),
              host,
              port,
            },
          };
        }
        return {
          name: "verify_server",
          arguments: {
            host,
            port,
            path: "/",
            timeoutMs: 15000,
          },
        };
      }

      if (makeDirLike && wantsDesktop) {
        const match = userContent.match(/called\s+([^\n]+)$/i);
        const name = match ? match[1].trim() : "new-folder";
        return {
          name: "run_command",
          arguments: { command: `mkdir -p "${path.join(desktop, name)}"` },
        };
      }

      if (listLike && wantsDesktop) {
        return {
          name: "list_dir",
          arguments: { path: desktop },
        };
      }

      if (listLike && wantsHome) {
        return {
          name: "list_dir",
          arguments: { path: home },
        };
      }

      if (listLike && referentialTarget?.path && referentialTarget.kind !== "file") {
        return {
          name: "list_dir",
          arguments: { path: referentialTarget.path },
        };
      }

      if (listLike && wantsWorkspace) {
        const workspaceRoot = config.workspaceRoot || process.cwd();
        const loopState = inspectToolLoopMessages(_payload?.messages || []);
        if (!loopState.hasUsed("list_dir")) {
          return {
            name: "list_dir",
            arguments: { path: workspaceRoot },
          };
        }
        return {
          name: "read_file",
          arguments: { path: path.join(workspaceRoot, "package.json") },
        };
      }

      if (listLike) {
        return { name: "list_dir", arguments: { path: home } };
      }

      if (readLike) {
        const target =
          currentFilesystemTarget?.path ||
          referentialTarget?.path ||
          (extractBareFileReference(userContent)
            ? path.join(
                explicitProjectDir || recentProjectDir || config.workspaceRoot || home,
                extractBareFileReference(userContent)
              )
            : "");
        if (target) {
          return { name: "read_file", arguments: { path: target } };
        }
      }

      if (editLike) {
        const target =
          editTargetPath ||
          currentFilesystemTarget?.path ||
          referentialTarget?.path ||
          (extractBareFileReference(userContent)
            ? path.join(
                explicitProjectDir || recentProjectDir || config.workspaceRoot || home,
                extractBareFileReference(userContent)
              )
            : "");
        if (target) {
          // If the model already read the file and is now narrating code,
          // extract the code from its response and create a write_file call.
          const loopState = inspectToolLoopMessages(_payload?.messages || []);
          const alreadyRead = loopState.hasUsed("read_file");
          if (alreadyRead && message?.content) {
            const codeMatch = message.content.match(/```[a-z0-9_+-]*\s*\n([\s\S]*?)```/);
            if (codeMatch && codeMatch[1]?.trim()) {
              return {
                name: "write_file",
                arguments: {
                  path: target,
                  content: codeMatch[1].trimEnd(),
                  createDirs: /[\\/]/.test(target),
                },
              };
            }
          }
          return { name: "read_file", arguments: { path: target } };
        }
      }

      if (repoStatusLike) {
        const workspaceRoot = config.workspaceRoot || process.cwd();
        return {
          name: "run_command",
          arguments: { command: `git -C "${workspaceRoot}" status --short` },
        };
      }

      if (pendingIntentMemoryItems.length > 0) {
        const nextMemory = pendingIntentMemoryItems[0];
        return {
          name: "save_memory",
          arguments: {
            content: nextMemory.content,
            type: nextMemory.type,
            tags: nextMemory.tags,
            confirmed: true,
            approved: true,
            confidence: 1,
          },
        };
      }

      if (deleteLike || moveLike || copyLike) {
        return null;
      }
      return null;
    };
    const allowedFallbackTools = new Set(activeRoleConfig.allowedTools || []);
    const roleAwareFallbackToolCall = async (...args) => {
      const candidate = await fallbackToolCall(...args);
      if (!candidate?.name) return null;
      return allowedFallbackTools.has(candidate.name) ? candidate : null;
    };

    // No hard-coded tool execution here; rely on model + tool loop.

    const fullMessages = [
      { role: "system", content: systemMessage },
      ...contextMessages,
    ];
    const promptMessageCount = fullMessages.length;
    const promptTokenEstimate =
      estimateTokens(systemMessage) +
      contextMessages.reduce(
        (sum, message) => sum + estimateTokens(message?.content),
        0
      );

    const activeModel = config.model;
    const isQwenCoder = isQwenCoderModel(activeModel);
    const usePromptOnlyTools = shouldUsePromptOnlyTools({
      endpoint: config.endpoint,
      modelName: activeModel,
      toolMode: config.toolMode,
    });

    // Build LLM payload with Qwen3-recommended sampling parameters
    const payload = {
      messages: fullMessages,
      temperature: config.temperature ?? 0.7,
      top_p: config.top_p ?? 0.8,
      top_k: config.top_k ?? 20,
      repetition_penalty: config.repetition_penalty ?? 1.05,
      stream: false,
    };
    if (config.max_tokens) {
      payload.max_tokens = config.max_tokens;
    }
    if (requiresTool && isQwenCoder) {
      payload.temperature = config.toolTemperature ?? 0.35;
      payload.repetition_penalty = config.toolRepetitionPenalty ?? 1.2;
      payload.top_k = config.toolTopK ?? 8;
    }
    // Scale max_tokens to use available context window.
    // Prefer a large completion budget for tool loops and final summaries,
    // while still leaving a small safety buffer for the prompt.
    if (isQwenCoder && !payload.max_tokens) {
      const inputEstimate = Math.ceil(promptTokenEstimate * 1.1);
      const ctxWindow = config.contextWindow || 28660;
      const availableForOutput = Math.max(1024, ctxWindow - inputEstimate - 512);
      const desiredOutputBudget =
        requiresTool || usePromptOnlyTools
          ? Math.max(15360, Math.floor(ctxWindow * 0.55))
          : Math.max(8192, Math.floor(ctxWindow * 0.4));
      payload.max_tokens = Math.min(availableForOutput, desiredOutputBudget);
    }
    if (typeof config.min_p === "number" && config.min_p > 0) {
      payload.min_p = config.min_p;
    }

    if (activeModel) payload.model = activeModel;
    if (config.statelessProvider) {
      payload.cache_prompt = false;
      payload.n_keep = 0;
      payload.slot_id = -1;
    } else {
      // Enable llama.cpp prompt caching for the system prompt
      payload.cache_prompt = true;
    }

    // Add tool definitions if available
    const allToolDefs = filterToolsForRole(registry.getDefinitions(), activeRole);
    const qwenForcedTools = (() => {
      const forced = new Set(
        Array.isArray(llmIntent?.tools) ? llmIntent.tools.filter(Boolean) : []
      );
      if (localMachineTask) forced.add("run_command");
      if (processTask) {
        forced.add("list_processes");
        if (processTask.intent === "stop") {
          forced.add("kill_process");
        } else {
          forced.add("start_dev_server");
          forced.add("verify_server");
        }
      }
      if (isWebLookup) {
        forced.add("web_search");
        forced.add("fetch_url");
      }
      if (isGitRequest) forced.add("run_command");
      const wantsMemory = /\b(?:remember|memory|recall|forget)\b/i.test(userContent);
      if (wantsMemory) {
        forced.add("save_memory");
        forced.add("search_memory");
      }
      if (intentMemoryItems.length > 0) {
        forced.add("save_memory");
      }
      return Array.from(forced);
    })();
    const toolDefs = isPureWebLookup && intentMemoryItems.length === 0
      ? allToolDefs.filter((tool) =>
          ["web_search", "fetch_url"].includes(tool?.function?.name || "")
        )
      : isQwenCoder
        ? registry.selectDefinitions(userContent, 10, qwenForcedTools)
        : allToolDefs;
    const roleToolDefs = workflowOptions.noTools
      ? []
      : filterToolsForRole(toolDefs, activeRole);
    const isConversational = llmIntent
      ? !requiresTool && llmIntent.category === "chat"
      : !requiresTool &&
        !isWebLookup &&
        !isGitRequest &&
        !processTask &&
        userContent.trim().length < 100 &&
        !/\b(?:install|build|create|make|run|start|stop|deploy|fix|update|add|delete|remove|write|read|open|save|remember|recall|forget|memory)\b/i.test(
          userContent
        );

    if (roleToolDefs.length > 0 && !isConversational && !usePromptOnlyTools) {
      payload.tools = roleToolDefs;
      if (isQwenCoder) {
        payload.tool_choice = "auto";
      }
    }
    if (requiresTool && llmIntent?.tasks?.length > 0) {
      const taskLines = llmIntent.tasks.map((t, i) => {
        const toolHint = t.tool ? ` → ${t.tool}` : "";
        const depHint = t.dependsOn != null ? ` (after step ${t.dependsOn + 1})` : "";
        return `${i + 1}. ${t.step}${toolHint}${depHint}`;
      });
      const taskPlanNote =
        "[Task plan] Execute these steps in order:\n" + taskLines.join("\n");
      payload.messages.push({
        role: "user",
        content: taskPlanNote,
      });
      await logEvent("task_plan", {
        conversationId,
        tasks: llmIntent.tasks,
      });
      updateChatProgress(
        conversationId,
        "running",
        `Task plan ready: ${llmIntent.tasks.length} steps`,
        { kind: "plan", phase: "ready" }
      );
    } else if (requiresTool) {
      const executionPlan = buildExecutionPlan({
        userContent,
        toolGuide: registry.buildToolGuide(userContent, 4),
        isWebLookup,
        processTask,
        localMachineTask,
        isGitRequest,
        isReadOnlyFsRequest,
        explicitProjectDir: inferProjectDirectory(userContent, config),
        recentProjectDir: inferRecentProjectDirectory(history, config),
        memoryItems: intentMemoryItems,
      });
      const planNote = formatExecutionPlanNote(executionPlan);
      if (planNote) {
        payload.messages.push({
          role: "user",
          content: planNote,
        });
        await logEvent("execution_plan", {
          conversationId,
          steps: executionPlan.steps,
        });
        updateChatProgress(
          conversationId,
          "running",
          `Plan ready: ${executionPlan.steps.join(" ")}`,
          { kind: "plan", phase: "ready" }
        );
      }
      if (
        (!llmIntent?.tasks || llmIntent.tasks.length === 0) &&
        executionPlan?.steps?.length > 0
      ) {
        const syntheticTasks = executionPlan.steps
          .map((step) => {
            const toolMatch = step.match(/\(([a-z_]+)\)/);
            return toolMatch ? { step, tool: toolMatch[1], done: false } : null;
          })
          .filter(Boolean);
        if (syntheticTasks.length > 0) {
          if (!llmIntent) {
            llmIntent = {
              needsTool: true,
              category: "other",
              tools: syntheticTasks.map((task) => task.tool),
              readOnly: null,
              maxRounds: null,
              targetPath: null,
              tasks: syntheticTasks,
              memoryItems: [],
            };
          } else {
            llmIntent.tasks = syntheticTasks;
          }
        }
      }
    }
    if (usePromptOnlyTools && isQwenCoder && roleToolDefs.length > 0 && !isConversational) {
      const qwenToolPrompt = buildQwenXmlToolSystemMessage(roleToolDefs);
      if (qwenToolPrompt) {
        payload.messages.splice(1, 0, {
          role: "system",
          content: qwenToolPrompt,
        });
      }
    }
    await logEvent("tools_available", {
      conversationId,
      toolCount: roleToolDefs.length,
      tools: roleToolDefs.map((t) => t.function?.name).filter(Boolean),
    });

    // Call LLM
    const llmStartedAt = Date.now();
    let llmCallCount = 0;
    let lastLlmResponse = null;
    const llmCompatTarget = resolveRoleCompatTarget(roleExecution);
    let llmPayloadCompatState = {
      disabledParams: getCachedUnsupportedPayloadParams(
        config.payloadCompatDisabledParams,
        llmCompatTarget
      ),
    };
    // Scale timeout with max_tokens — large writes on local 30B models need more time
    const llmTimeoutMs = Math.max(120_000, (payload.max_tokens || 4096) * 30);

    const callLLM = async (nextPayload) => {
      llmCallCount += 1;
      updateChatProgress(
        conversationId,
        "running",
        `LLM call ${llmCallCount}: waiting for model`,
        { kind: "llm", phase: "running" }
      );
      try {
        const effectivePayload =
          llmPayloadCompatState.disabledParams.length > 0
            ? stripUnsupportedPayloadParams(
                nextPayload,
                llmPayloadCompatState.disabledParams
              )
            : nextPayload;
        const data = await callRoleProviderWithCompat(
          providerRegistry,
          roleExecution,
          effectivePayload,
          {
            compatConfig: config,
            timeout: llmTimeoutMs,
            disabledParams: llmPayloadCompatState.disabledParams,
            sessionId: `${conversationId}:${activeRole}`,
            onCompatRetry: async ({ disabledParams, errorText }) => {
              llmPayloadCompatState = { disabledParams };
              await logEvent("llm_payload_compat_retry", {
                conversationId,
                disabledParams,
                errorText: String(errorText || "").slice(0, 1000),
              });
              updateChatProgress(
                conversationId,
                "running",
                `LLM compatibility retry without: ${disabledParams.join(", ")}`,
                { kind: "llm", phase: "compat_retry" }
              );
            },
          }
        );
        lastLlmResponse = data;
        await logEvent("llm_response", {
          conversationId,
          response: JSON.stringify(data).slice(0, 8000),
        });
        updateChatProgress(
          conversationId,
          "running",
          `LLM call ${llmCallCount}: response received`,
          { kind: "llm", phase: "done", role: activeRole }
        );
        updateChatProgress(
          conversationId,
          "running",
          describeLlmResponseForProgress(data, activeRole),
          { kind: "assistant", phase: "speaking", role: activeRole }
        );
        return data;
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        updateChatProgress(
          conversationId,
          "running",
          `LLM call ${llmCallCount}: failed (${errorText || "unknown error"})`,
          { kind: "llm", phase: "error" }
        );
        throw new Error(`LLM server error: ${errorText}`);
      }
    };

    const systemNotes = [];
    if (requiresTool && localMachineTask) {
      systemNotes.push(
        "This is a local machine info task. Use run_command to collect each requested value. " +
        "Do not stop after the first value if the user asked for more than one."
      );
    } else if (requiresTool && processTask) {
      systemNotes.push(
        processTask.intent === "stop"
          ? "This is a process-stop task. Use list_processes and kill_process. Verify port is free before responding."
          : "This is a server task. Use start_dev_server and verify_server. A PID alone is not enough."
      );
    } else if (isWebLookup) {
      if (isQuickWebAnswer) {
        systemNotes.push(
          "This is a quick web lookup. Use web_search once with a small result set and answer directly from the snippets. " +
          "Do not call fetch_url unless the user provided a specific URL."
        );
      } else {
        systemNotes.push(
          "Use web_search immediately with a small result set. Only use fetch_url when the snippets are insufficient or a URL was provided."
        );
      }
    } else if (requiresTool && isGitRequest) {
      systemNotes.push("Use github_repo and run_command for git operations. Verify with git ls-remote.");
    } else if (requiresTool) {
      systemNotes.push(
        "Execute using tools now. Do not describe what you would do. Use tools, then verify before the final response."
      );
    }
    if (requiresTool && editLikeRequest && editTargetPath) {
      systemNotes.push(
        `This is a file edit request for ${editTargetPath}. Inspect the file if needed, then call write_file with the updated contents. Do not paste code as plain text without a tool call.`
      );
    }
    if (requiresTool && isQwenCoderModel(activeModel) && !usePromptOnlyTools) {
      systemNotes.push(
        "Use the provided tool interface directly. Do not write bash blocks or plain-text JSON tool calls. Complete all requested steps before responding."
      );
    }
    if (intentMemoryItems.length > 0) {
      systemNotes.push(
        "Before the final response, call save_memory for each durable memory candidate detected in this turn. " +
        `Memory candidates: ${formatMemoryDirective(intentMemoryItems)}`
      );
    }
    if (systemNotes.length > 3) {
      systemNotes.length = 3;
    }
    if (systemNotes.length > 0) {
      payload.messages.push({
        role: "system",
        content: `[System note]\n${systemNotes.join("\n")}`,
      });
    }

    const configuredMaxRounds =
      typeof config.maxToolRounds === "number"
        ? config.maxToolRounds
        : DEFAULT_CONFIG.maxToolRounds;
    const roleMaxRounds = Math.min(
      configuredMaxRounds,
      activeRoleConfig.maxToolRounds || configuredMaxRounds
    );
    const effectiveMaxRounds = llmIntent?.maxRounds
      ? Math.min(roleMaxRounds, llmIntent.maxRounds)
      : requiresTool
        ? roleMaxRounds
        : Math.min(roleMaxRounds, 10);
    const maxToolRounds = isQuickWebAnswer
      ? Math.min(effectiveMaxRounds, 4)
      : isPureWebLookup
        ? Math.min(effectiveMaxRounds, 6)
        : effectiveMaxRounds;
    const serverCompletionGuard = buildServerCompletionGuard(userContent);
    const completionGuard = ({ payload: nextPayload, ...rest }) => {
      if (typeof serverCompletionGuard === "function") {
        const serverGuard = serverCompletionGuard({
          payload: nextPayload,
          ...rest,
        });
        if (serverGuard?.block) return serverGuard;
      }

      // Task-aware guard: check if all task steps with tools have been executed
      if (llmIntent?.tasks?.length > 0) {
        const loopState = inspectToolLoopMessages(nextPayload?.messages || []);
        // Count how many times each tool is needed vs how many times it's been used
        const toolTaskCounts = new Map();
        for (const t of llmIntent.tasks) {
          if (t.tool) toolTaskCounts.set(t.tool, (toolTaskCounts.get(t.tool) || 0) + 1);
        }
        const toolUseCounts = new Map();
        for (const name of loopState.usedNames) {
          toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
        }
        const pendingTasks = llmIntent.tasks.filter((t) => {
          if (!t.tool || t.done) return false;
          const needed = toolTaskCounts.get(t.tool) || 0;
          const used = toolUseCounts.get(t.tool) || 0;
          return used < needed;
        });
        if (pendingTasks.length > 0) {
          const nextTask = pendingTasks[0];
          return {
            block: true,
            phase: "task_step",
            note:
              `[System note] Task plan is not complete. Next step: ${nextTask.step}` +
              (nextTask.tool ? ` (use ${nextTask.tool})` : "") +
              ". Continue executing the plan.",
          };
        }
      }

      if (requiresTool && editLikeRequest && editTargetPath) {
        const mutationApplied = hasAppliedFilesystemMutation(nextPayload?.messages || []);
        if (!mutationApplied) {
          return {
            block: true,
            note:
              `[System note] The edit for ${editTargetPath} is not complete until you actually modify the file with write_file or another mutating tool. ` +
              "Do not just describe the code. Apply the change, then verify it before responding.",
          };
        }
      }

      if (intentMemoryItems.length === 0) return null;
      const pending = getPendingIntentMemoryItems(nextPayload?.messages || []);
      if (pending.length === 0) return null;
      return {
        block: true,
        phase: "save_memory",
        note:
          "[System note] Before the final response, save the durable memories from this turn with save_memory. " +
          `Still pending: ${formatMemoryDirective(pending)}`,
      };
    };
    const buildVerifyPrompt = ({ hasErrors, toolCalls, toolResults, defaultPrompt, payload: verifyPayload }) => {
      let prompt = defaultPrompt;
      if (isPureWebLookup && !hasErrors) {
        const toolNames = (Array.isArray(toolCalls) ? toolCalls : [])
          .map((toolCall) => toolCall?.function?.name)
          .filter(Boolean);
        if (isQuickWebAnswer && toolNames.includes("web_search")) {
          prompt =
            "[System note] The web search results above already contain the answer. Summarize the key facts from the snippets and links. NEVER say you cannot access current web content or that you need real-time access; you already have the search results. Answer now. Do not call fetch_url for this quick lookup.";
        } else if (toolNames.includes("fetch_url")) {
          prompt =
            isQuickWebAnswer
              ? "[System note] The fetched page text above already contains the answer. Summarize it directly. NEVER say you cannot access the content; you already have it. Answer now."
              : "[System note] Use the fetched page text to answer the user now. Only fetch another page if this page is clearly insufficient.";
        } else if (toolNames.includes("web_search")) {
          prompt =
            "[System note] Use these search results to answer the user now. Only call fetch_url if one result needs more detail.";
        }
      }
      // Task-aware verify: tell the model what the next step is
      if (llmIntent?.tasks?.length > 0) {
        const loopState = inspectToolLoopMessages(verifyPayload?.messages || []);
        const toolTaskCounts = new Map();
        for (const task of llmIntent.tasks) {
          if (task.tool) {
            toolTaskCounts.set(task.tool, (toolTaskCounts.get(task.tool) || 0) + 1);
          }
        }
        const toolUseCounts = new Map();
        for (const name of loopState.usedNames) {
          toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
        }
        const remaining = llmIntent.tasks.filter((task) => {
          if (!task.tool || task.done) return false;
          const needed = toolTaskCounts.get(task.tool) || 0;
          const used = toolUseCounts.get(task.tool) || 0;
          return used < needed;
        });
        if (remaining.length > 0) {
          const nextTask = remaining[0];
          prompt +=
            ` Next task step: ${nextTask.step}` +
            (nextTask.tool ? ` (use ${nextTask.tool})` : "") + ".";
        }
      }
      if (isQwenCoder) {
        return buildQwenToolContinuationPrompt({
          toolCalls,
          toolResults,
          defaultPrompt: prompt,
          toolStyle: usePromptOnlyTools ? "xml" : "native",
          editTargetPath: (editLikeRequest && editTargetPath) ? editTargetPath : "",
        });
      }
      return prompt;
    };
    const toolCallGuard = ({ payload: nextPayload, message }) => {
      const requestedToolNames = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
        .map((toolCall) => toolCall?.function?.name)
        .filter(Boolean);
      if (requestedToolNames.length === 0) return null;

      if (llmIntent?.tasks?.length > 0) {
        const loopState = inspectToolLoopMessages(nextPayload?.messages || []);
        const toolTaskCounts = new Map();
        for (const task of llmIntent.tasks) {
          if (task.tool) {
            toolTaskCounts.set(task.tool, (toolTaskCounts.get(task.tool) || 0) + 1);
          }
        }
        const toolUseCounts = new Map();
        for (const name of loopState.usedNames) {
          toolUseCounts.set(name, (toolUseCounts.get(name) || 0) + 1);
        }
        const remainingTasks = llmIntent.tasks.filter((task) => {
          if (!task.tool || task.done) return false;
          const needed = toolTaskCounts.get(task.tool) || 0;
          const used = toolUseCounts.get(task.tool) || 0;
          return used < needed;
        });
        if (remainingTasks.length === 0) {
          const allRequestedToolsAlreadySatisfied = requestedToolNames.every((name) => {
            if (name === "save_memory" || name === "update_memory") return false;
            const needed = toolTaskCounts.get(name) || 0;
            const used = toolUseCounts.get(name) || 0;
            return needed > 0 && used >= needed;
          });
          if (allRequestedToolsAlreadySatisfied) {
            const requestedLookupTerms = extractTargetLookupTerms(userContent);
            const requestedReadPaths = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
              .map((toolCall) => {
                if (toolCall?.function?.name !== "read_file") return "";
                try {
                  const args =
                    typeof toolCall?.function?.arguments === "string"
                      ? JSON.parse(toolCall.function.arguments)
                      : toolCall?.function?.arguments || {};
                  return typeof args?.path === "string" ? args.path : "";
                } catch {
                  return "";
                }
              })
              .filter(Boolean);
            const repeatedReadAlreadyHasAnswer =
              requestedLookupTerms.length > 0 &&
              requestedReadPaths.length > 0 &&
              requestedReadPaths.every((targetPath) => {
                const combinedContent = loopState.usedCalls
                  .filter((call) => call?.name === "read_file" && call?.args?.path === targetPath)
                  .map((call) => (typeof call?.result?.content === "string" ? call.result.content : ""))
                  .join("\n")
                  .toLowerCase();
                if (!combinedContent) return false;
                return requestedLookupTerms.every((term) =>
                  combinedContent.includes(term.toLowerCase())
                );
              });
            if (repeatedReadAlreadyHasAnswer) {
              return {
                block: true,
                note:
                  "[System note] The gathered file content already contains the exact labels or settings the user asked about. Do not read more. Answer from the content you already have.",
              };
            }
            const repeatedReadLimitReached =
              requestedReadPaths.length > 0 &&
              requestedReadPaths.every((targetPath) => {
                const readsForPath = loopState.usedCalls.filter(
                  (call) => call?.name === "read_file" && call?.args?.path === targetPath
                ).length;
                return readsForPath >= 4;
              });
            const nonReadRepeat = requestedToolNames.every((name) => name !== "read_file");
            if (!nonReadRepeat && !repeatedReadLimitReached) {
              return null;
            }
            return {
              block: true,
              note:
                "[System note] The planned tool steps are already complete. Do not keep repeating the same tool calls. Answer from the information you already gathered.",
            };
          }
        }
      }

      if (!isPureWebLookup) {
        return null;
      }

      {
        const loopState = inspectToolLoopMessages(nextPayload?.messages || []);
        const usedNames = Array.isArray(loopState?.usedNames) ? loopState.usedNames : [];
        const webSearchCount = usedNames.filter((name) => name === "web_search").length;
        const fetchUrlCount = usedNames.filter((name) => name === "fetch_url").length;
        const userProvidedUrl = /https?:\/\//.test(userContent);

        if (isQuickWebAnswer && !userProvidedUrl && requestedToolNames.includes("fetch_url")) {
          return {
            block: true,
            note:
              webSearchCount >= 1
                ? "[System note] This quick web lookup should be answered from the search snippets you already have. Do not fetch a full page. Summarize the snippets now and do not say you lack access to the content."
                : "[System note] This is a quick web lookup. Use web_search once and answer from the snippets. Do not call fetch_url unless the user gave a specific URL.",
          };
        }

        if (webSearchCount >= 1 && requestedToolNames.every((name) => name === "web_search")) {
          return {
            block: true,
            note:
              "[System note] You already searched the web for this request. Do not search again. Answer from the existing search results, or call fetch_url for one result only if more detail is required.",
          };
        }
        if (fetchUrlCount >= 1 && requestedToolNames.includes("fetch_url")) {
          return {
            block: true,
            note:
              "[System note] You already fetched a page for this quick web lookup. Do not fetch more pages. Answer now using the information you already have.",
          };
        }
        if (
          webSearchCount >= 1 &&
          fetchUrlCount >= 1 &&
          requestedToolNames.every((name) => name === "web_search" || name === "fetch_url")
        ) {
          return {
            block: true,
            note:
              "[System note] You already have enough web information for a quick lookup. Stop calling tools and answer the user now.",
          };
        }
        return null;
      }
    };

    const { assistantContent, finalResponse } = await runToolLoop({
      payload,
      callLLM,
      executeTool: async (name, args) => {
        args._source = {
          conversationId,
          messageTs: new Date().toISOString(),
        };
        await logEvent("tool_call", { conversationId, name, args });
        updateChatProgress(
          conversationId,
          "running",
          describeToolProgress(name, args, null, "running"),
          { kind: "tool", toolName: name, phase: "running" }
        );
        const result = await registry.execute(name, args);
        await logEvent("tool_result", { conversationId, name, result });
        const toolError =
          result?.error ||
          (result?.exitCode !== undefined && result?.exitCode !== 0);
        updateChatProgress(
          conversationId,
          "running",
          toolError
            ? describeToolProgress(name, args, result, "error")
            : describeToolProgress(name, args, result, "done"),
          {
            kind: "tool",
            toolName: name,
            phase: toolError ? "error" : "done",
          }
        );
        // Discovery memory: extract facts from tool results
        try {
          const discoveryFacts = detectDiscoveryFacts(name, result, memories, 5);
          for (const fact of discoveryFacts) {
            const created = await createMemory(
              fact.content,
              fact.tags,
              {
                kind: "tool_discovery",
                toolName: name,
                conversationId,
                messageTs: new Date().toISOString(),
              },
              { type: fact.type, confidence: 0.8, confirmed: false, approved: true }
            );
            if (created?.saved) memories.push(created);
          }
        } catch { /* never block tool execution for discovery */ }
        return result;
      },
      toolSkillLoader: (name) => registry.getSkill(name),
      preToolSkillInjection: false,
      verifyToolResults: true,
      requireToolCall: requiresTool,
      fallbackToolCall: roleAwareFallbackToolCall,
      directToolOutput: false,
      maxToolRounds,
      completionGuard,
      buildVerifyPrompt,
      toolCallGuard,
      editTargetPath: (editLikeRequest && editTargetPath) ? editTargetPath : "",
      onAssistantMessage: async (text, info = {}) => {
        const trimmed = String(text || "").trim();
        if (!trimmed) return;
        updateChatProgress(conversationId, "running", trimmed, {
          kind: "assistant",
          phase: info?.hasToolCalls ? "tool_call" : "speaking",
        });
      },
    });
    await logEvent("assistant_response", { conversationId, content: assistantContent });
    updateChatProgress(conversationId, "running", "Assistant response ready", {
      kind: "system",
      phase: "done",
    });
    const assistantMeta = buildAssistantMeta({
      finalResponse: finalResponse || lastLlmResponse,
      activeModel,
      configuredModel: config.model,
      providerId: roleExecution.provider?.id || config.provider,
      providerName: roleExecution.provider?.name || "",
      roleId: activeRole,
      contextMessages,
      promptTokenEstimate,
      promptMessageCount,
      elapsedMs: Date.now() - llmStartedAt,
      llmCalls: llmCallCount,
      toolTrace: buildToolTrace(payload.messages),
    });

    // Save assistant response to conversation
    if (workflowOptions.persistAssistantMessage) {
      await appendToConversation(conversationId, "assistant", assistantContent, {
        meta: assistantMeta,
      });
    }

    const assistantFacts = detectAssistantFacts(assistantContent, memories, 5);
    if (assistantFacts.length > 0) {
      for (const fact of assistantFacts) {
        await createMemory(
          fact.content,
          fact.tags,
          {
            kind: "assistant_fact",
            conversationId,
            messageTs: new Date().toISOString(),
          },
          { type: fact.type, confidence: fact.confidence, confirmed: false, approved: true }
        );
      }
    }

    // Update manifest metadata
    if (workflowOptions.persistUserMessage || workflowOptions.persistAssistantMessage) {
      const manifest = await loadManifest();
      const conv = manifest.conversations.find((c) => c.id === conversationId);
      if (conv) {
        conv.updatedAt = new Date().toISOString();
        const messageDelta =
          (workflowOptions.persistUserMessage ? 1 : 0) +
          (workflowOptions.persistAssistantMessage ? 1 : 0);
        conv.messageCount = (conv.messageCount || 0) + messageDelta;
        if (
          workflowOptions.persistUserMessage &&
          conv.title === "New conversation" &&
          history.length === 0
        ) {
          conv.title =
            userContent.length > 50
              ? `${userContent.substring(0, 47)}...`
              : userContent;
        }
        await saveManifest(manifest);
      }
    }

    const responsePayload = { content: assistantContent, meta: assistantMeta };
    sendJson(res, 200, responsePayload);
    updateChatProgress(conversationId, "completed", "Response sent", {
      kind: "system",
      phase: "done",
    });

    if (pendingSummary) {
      summarizeConversationHistory(
        pendingSummary.config,
        pendingSummary.existingSummary,
        pendingSummary.messages
      )
        .then(async (newSummary) => {
          if (!newSummary) return;
          const lastTs =
            pendingSummary.messages[pendingSummary.messages.length - 1]?.ts ||
            new Date().toISOString();
          await saveConversationSummary(pendingSummary.conversationId, {
            summary: newSummary,
            updatedAt: new Date().toISOString(),
            uptoTs: lastTs,
          });
        })
        .catch(() => {});
    }
    return responsePayload;
  } catch (error) {
    if (activeConversationId) {
      updateChatProgress(
        activeConversationId,
        "failed",
        `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        { kind: "system", phase: "error" }
      );
      if (workflowOptions.persistAssistantMessage && !workflowOptions.disableOrchestration) {
        const errorText =
          error instanceof Error
            ? error.message.startsWith("LLM server error:")
              ? `Request failed: ${error.message.replace(/^LLM server error:\s*/, "")}`
              : `Request failed: ${error.message}`
            : "Request failed: Unknown error";
        try {
          await appendToConversation(activeConversationId, "assistant", errorText, {
            meta: {
              role: failureRoleId,
              providerId: failureProviderId || null,
              error: true,
            },
          });
        } catch {}
      }
    }
    if (handleBodyErrors(res, error)) return;
    await logEvent("chat_error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        const payload = { error: "LLM request timed out" };
        sendJson(res, 504, payload);
        return payload;
      }
      if (error.message.startsWith("LLM server error")) {
        const payload = { error: error.message };
        sendJson(res, 502, payload);
        return payload;
      }
    }
    const payload = {
      error: "Agent runtime failure",
      details: error instanceof Error ? error.message : "Unknown error",
    };
    sendJson(res, 500, payload);
    return payload;
  }
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const validation = validateChatRequest(body);
    if (!validation.ok) {
      return sendJson(res, 400, { error: validation.errors.join(", ") });
    }

    const { conversationId } = validation.data;
    const existingJob = activeChatJobs.get(conversationId);
    if (existingJob) {
      return sendJson(res, 409, {
        error: "A chat request is already running for this conversation.",
        conversationId,
        status: "running",
      });
    }

    beginChatProgress(conversationId, "Queued request", {
      kind: "system",
    });

    const syntheticReq = createSyntheticJsonRequest(body);
    const syntheticRes = createNullResponse();
    const job = handleChatProcess(syntheticReq, syntheticRes)
      .catch(async (error) => {
        await logEvent("chat_background_error", {
          conversationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      })
      .finally(() => {
        activeChatJobs.delete(conversationId);
      });

    activeChatJobs.set(conversationId, {
      conversationId,
      startedAt: new Date().toISOString(),
      job,
    });

    return sendJson(res, 202, {
      accepted: true,
      conversationId,
      status: "running",
    });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to queue chat request",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ── Conversation route handlers ─────────────────────────────────────────────

async function handleListConversations(_req, res) {
  sendJson(res, 200, await loadManifest());
}

async function handleCreateConversation(req, res) {
  try {
    const body = await readJsonBody(req);
    const conv = await createConversation(body.title);
    sendJson(res, 201, conv);
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to create conversation",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleGetConversation(_req, res, id, url) {
  const limit = Number.parseInt(url.searchParams.get("limit") || "200", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const messages = await loadConversationMessages(id);
  const sliced = messages.slice(offset, offset + limit);
  sendJson(res, 200, { id, messages: sliced, total: messages.length });
}

async function handleDeleteConversation(_req, res, id) {
  await deleteConversation(id);
  sendJson(res, 200, { deleted: id });
}

async function handleDeleteAllConversations(_req, res) {
  await deleteAllConversations();
  sendJson(res, 200, { deleted: "all" });
}

async function handleUpdateConversation(req, res, id) {
  try {
    const body = await readJsonBody(req);
    const manifest = await loadManifest();
    const conv = manifest.conversations.find((c) => c.id === id);
    if (!conv) return sendJson(res, 404, { error: "Conversation not found" });
    if (body.title !== undefined) conv.title = body.title;
    if (body.setActive) manifest.activeId = id;
    await saveManifest(manifest);
    sendJson(res, 200, conv);
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to update conversation",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ── Memory route handlers ───────────────────────────────────────────────────

async function handleListMemories(_req, res, url) {
  const q = url.searchParams.get("q") || "";
  const tagsParam = url.searchParams.get("tags") || "";
  const tags = tagsParam
    ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  const limit = Number.parseInt(url.searchParams.get("limit") || "50", 10);
  const results = await searchMemories(q, tags);
  sendJson(res, 200, { memories: results.slice(0, limit) });
}

function buildMemoryGraph(memories, maxNodes = 5000, includeLinks = true) {
  const allowedTypes = new Set([
    "identity",
    "preference",
    "project",
    "workflow",
    "reference",
    "cluster",
  ]);
  const recentMemories = memories.slice(-maxNodes);
  const nodes = recentMemories.map((m) => {
    const useCount = typeof m.useCount === "number" ? m.useCount : 0;
    const confidence = typeof m.confidence === "number" ? m.confidence : 1;
    const isPinned = Array.isArray(m.tags) && m.tags.includes("pin");
    const tagType = Array.isArray(m.tags)
      ? m.tags.find((tag) => allowedTypes.has(String(tag).toLowerCase()))
      : null;
    const rawType = typeof m.type === "string" ? m.type.toLowerCase() : "";
    const type = allowedTypes.has(rawType) ? rawType : tagType || "reference";
    const size = Math.max(
      0.45,
      Math.min(
        3.2,
        0.4 + Math.log1p(useCount) * 0.45 + confidence * 0.4 + (isPinned ? 0.7 : 0)
      )
    );
    return {
      id: m.id,
      content: m.content,
      type,
      tags: m.tags || [],
      confirmed: m.confirmed !== false,
      approved: m.approved !== false,
      confidence,
      useCount,
      size,
      lastUsed: m.lastUsed || null,
    };
  });

  if (!includeLinks) {
    return { nodes, links: [] };
  }

  const memoryById = new Map(recentMemories.map((mem) => [mem.id, mem]));
  const embeddingById = new Map(
    recentMemories.map((mem) => [mem.id, mem.embedding || buildEmbedding(mem.content || "")])
  );
  const normalizedById = new Map(
    recentMemories.map((mem) => [mem.id, normalizeMemoryComparable(mem.content || "")])
  );
  const tokenBuckets = new Map();
  const exactBuckets = new Map();

  for (const mem of recentMemories) {
    const normalized = normalizedById.get(mem.id) || "";
    if (normalized) {
      if (!exactBuckets.has(normalized)) exactBuckets.set(normalized, []);
      exactBuckets.get(normalized).push(mem.id);
    }
    for (const token of getGraphTokens(mem.content || "")) {
      if (!tokenBuckets.has(token)) tokenBuckets.set(token, []);
      tokenBuckets.get(token).push(mem.id);
    }
  }

  const candidateKeys = new Set();
  if (recentMemories.length <= 800) {
    for (let i = 0; i < recentMemories.length; i += 1) {
      for (let j = i + 1; j < recentMemories.length; j += 1) {
        candidateKeys.add(`${recentMemories[i].id}::${recentMemories[j].id}`);
      }
    }
  } else {
    for (const mem of recentMemories) {
      const ownId = mem.id;
      const normalized = normalizedById.get(ownId) || "";
      const candidateIds = new Set();
      if (normalized && exactBuckets.has(normalized)) {
        for (const id of exactBuckets.get(normalized)) candidateIds.add(id);
      }
      for (const token of getGraphTokens(mem.content || "")) {
        const bucket = tokenBuckets.get(token) || [];
        if (bucket.length > 96) continue;
        for (const id of bucket) candidateIds.add(id);
      }
      for (const otherId of candidateIds) {
        if (otherId === ownId) continue;
        const [a, b] = [ownId, otherId].sort();
        candidateKeys.add(`${a}::${b}`);
      }
    }
  }

  const candidateLinks = [];
  for (const key of candidateKeys) {
    const [source, target] = key.split("::");
    const left = memoryById.get(source);
    const right = memoryById.get(target);
    if (!left || !right) continue;
    const lexical = memoryTextSimilarity(left.content || "", right.content || "");
    const tokenOverlap = getGraphTokenOverlap(left.content || "", right.content || "");
    const semantic = cosineSimilarityFromVectors(
      embeddingById.get(source),
      embeddingById.get(target)
    );
    const identical =
      (normalizedById.get(source) || "") !== "" &&
      normalizedById.get(source) === normalizedById.get(target);
    const combined = Math.max(lexical, semantic * 0.78, tokenOverlap.score * 0.92);

    if (
      !(
        identical ||
        tokenOverlap.sharedCount >= 2 ||
        lexical >= 0.3 ||
        semantic >= 0.45 ||
        combined >= 0.42
      )
    ) {
      continue;
    }

    let kind = "related";
    let pulseSpeed = 0.0045;
    if (identical || lexical >= 0.92 || tokenOverlap.score >= 0.95) {
      kind = "duplicate";
      pulseSpeed = 0.014;
    } else if (lexical >= 0.6 || tokenOverlap.score >= 0.66 || tokenOverlap.sharedCount >= 3) {
      kind = "strong";
      pulseSpeed = 0.0095;
    } else {
      pulseSpeed = 0.006;
    }

    candidateLinks.push({
      source,
      target,
      weight: Number(Math.max(combined, lexical, tokenOverlap.score).toFixed(3)),
      lexical: Number(Math.max(lexical, tokenOverlap.score).toFixed(3)),
      semantic: Number(semantic.toFixed(3)),
      kind,
      pulseSpeed,
    });
  }

  candidateLinks.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.lexical !== a.lexical) return b.lexical - a.lexical;
    return a.source.localeCompare(b.source);
  });

  const links = [];
  const linkCounts = new Map();
  const maxLinksPerNode = 8;
  for (const link of candidateLinks) {
    const sourceCount = linkCounts.get(link.source) || 0;
    const targetCount = linkCounts.get(link.target) || 0;
    if (sourceCount >= maxLinksPerNode || targetCount >= maxLinksPerNode) continue;
    links.push(link);
    linkCounts.set(link.source, sourceCount + 1);
    linkCounts.set(link.target, targetCount + 1);
  }

  return { nodes, links };
}

async function handleCreateMemoryRoute(req, res) {
  try {
    const body = await readJsonBody(req);
    if (!body.content) {
      return sendJson(res, 400, { error: "content is required" });
    }
    const mem = await createMemory(body.content, body.tags, body.source);
    sendJson(res, 201, mem);
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to create memory",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleDeleteMemoryRoute(_req, res, id) {
  const result = await deleteMemory(id);
  if (!result.deleted) {
    return sendJson(res, 404, { error: "Memory not found" });
  }
  sendJson(res, 200, { deleted: id });
}

async function handleDeleteAllMemories(_req, res) {
  await deleteAllMemories();
  sendJson(res, 200, { deleted: "all" });
}

async function handleUpdateMemoryRoute(req, res, id) {
  try {
    const body = await readJsonBody(req);
    const result = await updateMemoryById(id, body);
    if (!result.updated) return sendJson(res, 404, { error: result.error });
    sendJson(res, 200, { updated: id });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to update memory",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleMemoryGraph(_req, res, url) {
  const limit = Number.parseInt(url.searchParams.get("limit") || "2000", 10);
  const memories = await loadAllMemories();
  const includeLinks = url.searchParams.get("links") !== "0";
  const graph = buildMemoryGraph(memories, limit, includeLinks);
  sendJson(res, 200, { ...graph, total: memories.length });
}

async function handleMemorySummary(req, res) {
  try {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    if (ids.length === 0) {
      return sendJson(res, 400, { error: "ids are required" });
    }

    const memories = await loadAllMemories();
    const selected = memories.filter((m) => ids.includes(m.id));
    const content = selected.map((m) => `- ${m.content}`).join("\n");
    const config = await loadConfig();

    const payload = {
      messages: [
        {
          role: "system",
          content:
            "Summarize the memories into one short, durable memory (max 140 chars).",
        },
        { role: "user", content },
      ],
      temperature: 0.2,
      stream: false,
    };
    const providerRegistry = buildProviderRegistry(config);
    const roleExecution = resolveRoleExecution(
      config,
      providerRegistry,
      "maintenance"
    );
    const activeModel = roleExecution?.assignment?.model || config.model;
    if (activeModel) payload.model = activeModel;

    const data = await callRoleProviderWithCompat(providerRegistry, roleExecution, payload, {
      compatConfig: config,
      timeout: 120000,
    });
    const summary =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.response ||
      "";
    sendJson(res, 200, { summary });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to summarize memories",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function buildDebugChatSnapshot({
  conversationId = "debug",
  userContent,
  configOverrides,
} = {}) {
  const config = await loadConfig(sanitizeConfigInput(configOverrides));
  const history = conversationId
    ? await loadConversationMessages(conversationId)
    : [];

  const classifyStartedAt = Date.now();
  let llmIntent = null;
  let classifyError = "";
  try {
    llmIntent = await classifyIntent(userContent, config);
  } catch (error) {
    classifyError =
      error instanceof Error ? error.message : "Failed to classify intent";
  }
  const classifyDurationMs = Date.now() - classifyStartedAt;

  const summaryState = conversationId
    ? await loadConversationSummary(conversationId)
    : null;
  const summaryText = summaryState?.summary || "";
  const recentMessages =
    history.length > SUMMARY_KEEP_MESSAGES
      ? history.slice(-SUMMARY_KEEP_MESSAGES)
      : history;
  const contextMessages = recentMessages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  contextMessages.push({ role: "user", content: userContent });
  if (summaryText) {
    contextMessages.unshift({
      role: "user",
      content:
        `[Conversation summary — do not respond to this, it is context only]\n${summaryText}`,
    });
  }

  const contextCharBudget =
    typeof config.contextCharBudget === "number"
      ? config.contextCharBudget
      : CONTEXT_CHAR_BUDGET;
  let totalChars = contextMessages.reduce(
    (sum, message) => sum + (message.content?.length || 0),
    0
  );
  while (totalChars > contextCharBudget && contextMessages.length > 2) {
    const removed = contextMessages[summaryText ? 1 : 0];
    if (!removed) break;
    contextMessages.splice(summaryText ? 1 : 0, 1);
    totalChars -= removed.content?.length || 0;
  }

  const [corePrompt, userMd, soulMd, skillsSummary] = await Promise.all([
    readText(PATHS.core, DEFAULT_CORE_PROMPT),
    readText(PATHS.user, ""),
    readText(PATHS.soul, ""),
    loadSkillsSummary(),
  ]);

  const memories = await loadAllMemories();
  const recentContext = history
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => message.content)
    .join(" ");
  const combinedQuery = [recentContext, userContent].filter(Boolean).join(" ");
  const usableMemories = memories.filter(
    (memory) =>
      !(Array.isArray(memory?.tags) && memory.tags.includes("summary")) &&
      memory?.source?.kind !== "auto_summary"
  );
  const isShortFollowUp = userContent.trim().length < 20 && history.length > 2;
  const relevantMemoryLimit = inferRelevantMemoryLimit(
    usableMemories,
    combinedQuery,
    5,
    10,
    {
      minScore: isShortFollowUp ? 0 : 1,
      referenceMaxAgeDays: 45,
      maxAgeDays: 180,
    }
  );
  const selectedMemories = selectMemoriesWithFallback(
    usableMemories,
    combinedQuery,
    relevantMemoryLimit,
    {
      maxPinned: 2,
      maxAgeDays: 180,
      referenceMaxAgeDays: 45,
      minScore: isShortFollowUp ? 0 : 1,
    }
  );
  const relevantMemories = guaranteeMinMemories(
    selectedMemories,
    usableMemories,
    2
  );

  const githubLine =
    config?.githubUsername && config?.githubToken
      ? `GitHub: ${config.githubUsername} (use github_repo)`
      : "";
  const workspaceSummary = config?.workspaceRoot
    ? [
        "[Workspace]",
        `root: ${config.workspaceRoot}`,
        `desktop: ${config.desktopDir || path.join(config.workspaceRoot, "Desktop")}`,
        githubLine,
        `shell_access: ${config.unrestrictedShell ? "unrestricted" : "guarded"}`,
        `web_search: ${config.webSearchEnabled ? "enabled" : "disabled"}`,
        "Use tools for file ops. Resolve relative paths from root.",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const systemMessage = buildSystemPrompt({
    corePrompt,
    userMd,
    soulMd,
    skillsSummary: config.lightweightMode ? "" : skillsSummary,
    workspaceSummary,
    memories: relevantMemories,
    maxMemoryItems: config.maxMemoryItems,
    maxMemoryChars: config.maxMemoryChars,
  });

  const processTask = classifyProcessTask(userContent);
  const localMachineTask = classifyLocalMachineInfoTask(userContent);
  const isWebLookup =
    Boolean(config.webSearchEnabled) && looksLikeWebLookupRequest(userContent);
  const explicitProjectDir = inferProjectDirectory(userContent, config);
  const recentProjectDir = inferRecentProjectDirectory(history, config);
  const recentFilesystemTarget = inferRecentFilesystemTarget(history, config);
  const currentFilesystemTarget = inferFilesystemTarget(userContent, {
    homeDir: config.homeDir || os.homedir(),
    desktopDir:
      config.desktopDir ||
      path.join(config.homeDir || os.homedir(), "Desktop"),
    workspaceRoot:
      config.workspaceRoot || config.homeDir || os.homedir(),
    fallbackDir:
      explicitProjectDir ||
      recentProjectDir ||
      config.workspaceRoot ||
      config.homeDir ||
      os.homedir(),
  });
  const referentialFilesystemFollowUp =
    looksLikeReferentialFilesystemFollowUp(userContent) &&
    Boolean(recentFilesystemTarget?.path);
  const intentMemoryItems = normalizeIntentMemoryItems(
    llmIntent?.memoryItems
  ).filter((item) => !isMemoryAlreadyKnown(item.content, memories));

  const requiresTool = (() => {
    if (intentMemoryItems.length > 0) return true;
    if (llmIntent) return llmIntent.needsTool;
    const text = userContent.toLowerCase();
    if (/\b(?:ls|cat|mkdir|rmdir|pwd|cd)\b/.test(text)) return true;
    if (/\b(?:read|open|write|save)\s+(?:the\s+)?(?:file|document)\b/.test(text)) {
      return true;
    }
    if (/\b(?:list|show|what'?s?\s+in)\s+(?:the\s+)?(?:folder|directory|desktop|home)\b/.test(text)) {
      return true;
    }
    if (/\b(?:create|make)\s+(?:a\s+)?(?:file|folder|directory)\b/.test(text)) {
      return true;
    }
    if (/\b(?:delete|remove)\s+(?:the\s+)?(?:file|folder|directory)\b/.test(text)) {
      return true;
    }
    if (/\b(?:move|rename|copy)\s+(?:the\s+)?(?:file|folder|directory)\b/.test(text)) {
      return true;
    }
    if (/\b(?:run|execute)\s+(?:the\s+)?(?:command|script|bash|shell)\b/.test(text)) {
      return true;
    }
    if (/\b(?:inspect|explore|scan|review|look\s+through|go\s+through|find|go\s+into|navigate\s+to)\b/.test(text) &&
      /\b(?:file|files|folder|directory|project|repo|repository|codebase|source|structure|src)\b/.test(text)) {
      return true;
    }
    if (/\b(?:see|understand|inspect|explore)\s+(?:how\s+(?:you|it)\s+work|yourself|your\s+own\s+(?:files|code|project|repo|repository|structure))\b/.test(text)) {
      return true;
    }
    if (/\bfile\s+structure\b/.test(text)) return true;
    if (/\b(?:desktop|home)\b/.test(text) && /\b(?:go\s+(?:to|into)|open|list|show|read|find|navigate|what'?s?\s+in)\b/.test(text)) {
      return true;
    }
    if (looksLikeEditRequest(userContent) && Boolean(extractBareFileReference(userContent))) {
      return true;
    }
    if (referentialFilesystemFollowUp) return true;
    if (currentFilesystemTarget?.path &&
      /\b(?:open|read|show|list|view|edit|change|modify|update|replace)\b/.test(text)) {
      return true;
    }
    if (localMachineTask) return true;
    if (processTask) return true;
    if (/\b(?:create|build|scaffold|set\s*up|initialize|init)\s+(?:a\s+)?(?:new\s+)?(?:project|app|application|website|site|repo|repository)\b/.test(text)) {
      return true;
    }
    if (/\b(?:install|add|remove|uninstall)\s+\w/.test(text) &&
      /\b(?:package|dependency|dep|lib|library|module|shadcn|tailwind|prisma|next|react|vue|express)\b/.test(text)) {
      return true;
    }
    if (/\b(?:fix|update|change|modify|edit|refactor|debug|recode|redesign|rebuild|rework|redo|restyle|revamp|overhaul|rewrite|transform)\s+(?:the\s+|my\s+|this\s+|that\s+)?(?:code|bug|error|issue|style|styling|layout|page|component|function|api|route|config|file|dashboard|ui|view|screen)\b/.test(text)) {
      return true;
    }
    if (/\b(?:add|create|implement|build)\s+(?:a\s+|an\s+|the\s+)?(?:page|component|feature|form|button|modal|sidebar|navbar|header|footer|api|route|endpoint|test)\b/.test(text)) {
      return true;
    }
    if (/\b(?:show|check|review)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current)\s+(?:changes|status)\b/.test(text)) {
      return true;
    }
    if (/\b(?:deploy|push|publish|upload|host)\b/.test(text)) return true;
    if (/\bnpx?\s+\w/.test(text)) return true;
    if (isWebLookup) return true;
    if (/(?:^|\s)[~.]?\/\w/.test(text)) return true;
    if (extractBareFileReference(userContent) && /\b(?:go|find|recode|redesign|make|look|create|build|write|edit|update|change|modify|open|read|fix|style|add|remove|delete|check)\b/.test(text)) return true;
    return false;
  })();

  const isGitRequest = (() => {
    if (Array.isArray(llmIntent?.tools) && llmIntent.tools.includes("github_repo")) {
      return true;
    }
    return /\b(git|github|repo|repository|commit|push|pull|clone|branch)\b/.test(
      userContent.toLowerCase()
    );
  })();
  const isReadOnlyFsRequest = (() => {
    if (llmIntent && llmIntent.readOnly != null) return llmIntent.readOnly;
    const text = userContent.toLowerCase();
    const readish =
      /\b(?:list|show|what'?s?\s+in|whats?\s+in|read|open|view|stat|exists|inspect|explore|scan|review|look\s+through|go\s+through)\b/.test(
        text
      );
    const writeish =
      /\b(?:create|make|write|save|delete|remove|move|rename|copy|mkdir|rmdir|touch)\b/.test(
        text
      );
    return readish && !writeish;
  })();
  const isPureWebLookup =
    (llmIntent ? llmIntent.category === "web" : isWebLookup) &&
    !processTask &&
    !isGitRequest &&
    !/\b(?:file|folder|directory|desktop|home|terminal|shell|command|script|git|repo|repository|server|port)\b/.test(
      userContent.toLowerCase()
    );
  const isQuickWebAnswer = isPureWebLookup && isQuickWebAnswerRequest(userContent);

  const fullMessages = [
    { role: "system", content: systemMessage },
    ...contextMessages,
  ];
  const activeModel = config.model;
  const isQwenCoder = isQwenCoderModel(activeModel);
  const usePromptOnlyTools = shouldUsePromptOnlyTools({
    endpoint: config.endpoint,
    modelName: activeModel,
    toolMode: config.toolMode,
  });
  const payload = {
    messages: fullMessages,
    temperature: config.temperature ?? 0.7,
    top_p: config.top_p ?? 0.8,
    top_k: config.top_k ?? 20,
    repetition_penalty: config.repetition_penalty ?? 1.05,
    stream: false,
  };
  if (config.max_tokens) {
    payload.max_tokens = config.max_tokens;
  }
  if (requiresTool && isQwenCoder) {
    payload.temperature = config.toolTemperature ?? 0.35;
    payload.repetition_penalty = config.toolRepetitionPenalty ?? 1.2;
    payload.top_k = config.toolTopK ?? 8;
  }
  if (isQwenCoder && !payload.max_tokens) {
    const ctxWindow = config.contextWindow || 28660;
    const inputEstimate = Math.ceil(promptTokenEstimate * 1.1);
    const availableForOutput = Math.max(1024, ctxWindow - inputEstimate - 512);
    const desiredOutputBudget =
      requiresTool || usePromptOnlyTools
        ? Math.max(15360, Math.floor(ctxWindow * 0.55))
        : Math.max(8192, Math.floor(ctxWindow * 0.4));
    payload.max_tokens = Math.min(availableForOutput, desiredOutputBudget);
  }
  if (typeof config.min_p === "number" && config.min_p > 0) {
    payload.min_p = config.min_p;
  }
  if (activeModel) payload.model = activeModel;
  if (config.statelessProvider) {
    payload.cache_prompt = false;
    payload.n_keep = 0;
    payload.slot_id = -1;
  } else {
    payload.cache_prompt = true;
  }

  const allToolDefs = registry.getDefinitions();
  const qwenForcedTools = (() => {
    const forced = new Set(
      Array.isArray(llmIntent?.tools) ? llmIntent.tools.filter(Boolean) : []
    );
    if (localMachineTask) forced.add("run_command");
    if (processTask) {
      forced.add("list_processes");
      if (processTask.intent === "stop") {
        forced.add("kill_process");
      } else {
        forced.add("start_dev_server");
        forced.add("verify_server");
      }
    }
    if (isWebLookup) {
      forced.add("web_search");
      forced.add("fetch_url");
    }
    if (isGitRequest) forced.add("run_command");
    const wantsMemory = /\b(?:remember|memory|recall|forget)\b/i.test(userContent);
    if (wantsMemory) {
      forced.add("save_memory");
      forced.add("search_memory");
    }
    if (intentMemoryItems.length > 0) {
      forced.add("save_memory");
    }
    return Array.from(forced);
  })();
  const toolDefs = isPureWebLookup && intentMemoryItems.length === 0
    ? allToolDefs.filter((tool) =>
        ["web_search", "fetch_url"].includes(tool?.function?.name || "")
      )
    : isQwenCoder
      ? registry.selectDefinitions(userContent, 10, qwenForcedTools)
      : allToolDefs;
  const isConversational = llmIntent
    ? !requiresTool && llmIntent.category === "chat"
    : !requiresTool &&
      !isWebLookup &&
      !isGitRequest &&
      !processTask &&
      userContent.trim().length < 100 &&
      !/\b(?:install|build|create|make|run|start|stop|deploy|fix|update|add|delete|remove|write|read|open|save|remember|recall|forget|memory)\b/i.test(
        userContent
      );

  if (toolDefs.length > 0 && !isConversational && !usePromptOnlyTools) {
    payload.tools = toolDefs;
    if (isQwenCoder) {
      payload.tool_choice = "auto";
    }
  }

  let executionPlan = null;
  if (requiresTool && llmIntent?.tasks?.length > 0) {
    const taskLines = llmIntent.tasks.map((task, index) => {
      const toolHint = task.tool ? ` -> ${task.tool}` : "";
      const depHint =
        task.dependsOn != null ? ` (after step ${task.dependsOn + 1})` : "";
      return `${index + 1}. ${task.step}${toolHint}${depHint}`;
    });
    const taskPlanNote =
      "[Task plan] Execute these steps in order:\n" + taskLines.join("\n");
    executionPlan = {
      steps: llmIntent.tasks.map((task) => task.step),
      note: taskPlanNote,
      source: "llm",
    };
    payload.messages.push({
      role: "user",
      content: taskPlanNote,
    });
  } else if (requiresTool) {
    const plan = buildExecutionPlan({
      userContent,
      toolGuide: registry.buildToolGuide(userContent, 4),
      isWebLookup,
      processTask,
      localMachineTask,
      isGitRequest,
      isReadOnlyFsRequest,
      explicitProjectDir,
      recentProjectDir,
      memoryItems: intentMemoryItems,
    });
    const planNote = formatExecutionPlanNote(plan);
    executionPlan = {
      ...plan,
      note: planNote,
      source: "regex",
    };
    if (planNote) {
      payload.messages.push({
        role: "user",
        content: planNote,
      });
    }
    if ((!llmIntent?.tasks || llmIntent.tasks.length === 0) && plan.steps?.length > 0) {
      const syntheticTasks = plan.steps
        .map((step) => {
          const toolMatch = step.match(/\(([a-z_]+)\)/);
          return toolMatch ? { step, tool: toolMatch[1], done: false } : null;
        })
        .filter(Boolean);
      if (syntheticTasks.length > 0) {
        if (!llmIntent) {
          llmIntent = {
            needsTool: true,
            category: "other",
            tools: syntheticTasks.map((task) => task.tool),
            readOnly: null,
            maxRounds: null,
            targetPath: null,
            tasks: syntheticTasks,
            memoryItems: [],
          };
        } else {
          llmIntent.tasks = syntheticTasks;
        }
      }
    }
  }

  if (usePromptOnlyTools && isQwenCoder && toolDefs.length > 0 && !isConversational) {
    const qwenToolPrompt = buildQwenXmlToolSystemMessage(toolDefs);
    if (qwenToolPrompt) {
      payload.messages.splice(1, 0, {
        role: "system",
        content: qwenToolPrompt,
      });
    }
  }

  const systemNotes = [];
  if (requiresTool && localMachineTask) {
    systemNotes.push(
      "This is a local machine info task. Use run_command to collect each requested value. Do not stop after the first value if the user asked for more than one."
    );
  } else if (requiresTool && processTask) {
    systemNotes.push(
      processTask.intent === "stop"
        ? "This is a process-stop task. Use list_processes and kill_process. Verify port is free before responding."
        : "This is a server task. Use start_dev_server and verify_server. A PID alone is not enough."
    );
  } else if (isWebLookup) {
    systemNotes.push(
      isQuickWebAnswer
        ? "This is a quick web lookup. Use web_search once with a small result set and answer directly from the snippets. Do not call fetch_url unless the user provided a specific URL."
        : "Use web_search immediately with a small result set. Only use fetch_url when the snippets are insufficient or a URL was provided."
    );
  } else if (requiresTool && isGitRequest) {
    systemNotes.push(
      "Use github_repo and run_command for git operations. Verify with git ls-remote."
    );
  } else if (requiresTool) {
    systemNotes.push(
      "Execute using tools now. Do not describe what you would do. Use tools, then verify before the final response."
    );
  }
  if (requiresTool && isQwenCoder && !usePromptOnlyTools) {
    systemNotes.push(
      "Use the provided tool interface directly. Do not write bash blocks or plain-text JSON tool calls. Complete all requested steps before responding."
    );
  }
  if (intentMemoryItems.length > 0) {
    systemNotes.push(
      "Before the final response, call save_memory for each durable memory candidate detected in this turn. " +
      `Memory candidates: ${formatMemoryDirective(intentMemoryItems)}`
    );
  }
  if (systemNotes.length > 3) {
    systemNotes.length = 3;
  }
  if (systemNotes.length > 0) {
    payload.messages.push({
      role: "system",
      content: `[System note]\n${systemNotes.join("\n")}`,
    });
  }

  const promptTokenEstimate = payload.messages.reduce(
    (sum, message) => sum + estimateTokens(message?.content),
    0
  );
  const selectedToolNames = toolDefs
    .map((tool) => tool?.function?.name)
    .filter(Boolean);

  return {
    conversationId,
    config,
    llmIntent,
    classifyError,
    classifyDurationMs,
    regexResults: {
      requiresTool,
      isWebLookup,
      processTask,
      localMachineTask,
      isGitRequest,
      isReadOnlyFsRequest,
      isPureWebLookup,
      isQuickWebAnswer,
      referentialFilesystemFollowUp,
      usePromptOnlyTools,
      isConversational,
    },
    selectedTools: selectedToolNames,
    toolDefs,
    executionPlan,
    systemMessage,
    payload,
    promptTokenEstimate,
    promptMessageCount: payload.messages.length,
    relevantMemories,
  };
}

async function handleDebugClassify(req, res) {
  try {
    const body = await readJsonBody(req);
    const message =
      typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return sendJson(res, 400, { error: "message is required" });
    }
    const snapshot = await buildDebugChatSnapshot({
      conversationId:
        typeof body?.conversationId === "string"
          ? body.conversationId.trim()
          : "debug-classify",
      userContent: message,
      configOverrides: body?.config,
    });
    return sendJson(res, 200, {
      llmResult: snapshot.llmIntent,
      classifyError: snapshot.classifyError,
      regexResults: snapshot.regexResults,
      selectedTools: snapshot.toolDefs.map((tool) => ({
        name: tool?.function?.name || "",
        description: tool?.function?.description || "",
      })),
      executionPlan: snapshot.executionPlan,
      durationMs: snapshot.classifyDurationMs,
    });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    return sendJson(res, 500, {
      error: "Failed to debug classifyIntent",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleDebugPrompt(req, res) {
  try {
    const body = await readJsonBody(req);
    const message =
      typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      return sendJson(res, 400, { error: "message is required" });
    }
    const snapshot = await buildDebugChatSnapshot({
      conversationId:
        typeof body?.conversationId === "string"
          ? body.conversationId.trim()
          : "debug-prompt",
      userContent: message,
      configOverrides: body?.config,
    });
    return sendJson(res, 200, {
      conversationId: snapshot.conversationId,
      classify: {
        llmResult: snapshot.llmIntent,
        classifyError: snapshot.classifyError,
        durationMs: snapshot.classifyDurationMs,
      },
      regexResults: snapshot.regexResults,
      executionPlan: snapshot.executionPlan,
      systemMessage: snapshot.systemMessage,
      messages: snapshot.payload.messages,
      toolDefs: snapshot.toolDefs,
      promptTokenEstimate: snapshot.promptTokenEstimate,
      promptMessageCount: snapshot.promptMessageCount,
      usePromptOnlyTools: snapshot.regexResults.usePromptOnlyTools,
      selectedMemories: snapshot.relevantMemories,
      payload: snapshot.payload,
    });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    return sendJson(res, 500, {
      error: "Failed to inspect prompt payload",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleTestMemoryQuery(req, res) {
  try {
    const body = await readJsonBody(req);
    const query = typeof body?.query === "string" ? body.query.trim() : "";
    if (!query) {
      return sendJson(res, 400, { error: "query is required" });
    }
    const limit = Math.max(
      1,
      Math.min(25, Number.parseInt(String(body?.limit || "10"), 10) || 10)
    );
    const memories = await loadAllMemories();
    const usableMemories = memories.filter(
      (memory) =>
        !(Array.isArray(memory?.tags) && memory.tags.includes("summary")) &&
        memory?.source?.kind !== "auto_summary"
    );
    const inferredLimit = inferRelevantMemoryLimit(
      usableMemories,
      query,
      Math.min(limit, 6),
      Math.max(limit, 10),
      {
        minScore: 0,
        referenceMaxAgeDays: 45,
        maxAgeDays: 180,
      }
    );
    const selected = selectMemoriesWithFallback(
      usableMemories,
      query,
      inferredLimit,
      {
        maxPinned: 2,
        maxAgeDays: 180,
        referenceMaxAgeDays: 45,
        minScore: 0,
      }
    );
    const scored = usableMemories
      .map((memory) => {
        const explanation = explainMemoryScore(memory, query);
        return {
          ...memory,
          score: Number(explanation.score.toFixed(3)),
          breakdown: explanation.breakdown,
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    const typeDistribution = usableMemories.reduce((acc, memory) => {
      const type = typeof memory?.type === "string" ? memory.type : "general";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    const ageSamples = usableMemories
      .map((memory) => {
        const ts = memory?.lastUsed || memory?.ts;
        const age = ts ? (Date.now() - Date.parse(ts)) / 86_400_000 : null;
        return Number.isFinite(age) ? age : null;
      })
      .filter((age) => age != null);
    const averageAgeDays =
      ageSamples.length > 0
        ? ageSamples.reduce((sum, age) => sum + age, 0) / ageSamples.length
        : null;

    return sendJson(res, 200, {
      query,
      total: usableMemories.length,
      selected,
      scored,
      inferredLimit,
      averageAgeDays:
        averageAgeDays == null ? null : Number(averageAgeDays.toFixed(1)),
      typeDistribution,
    });
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    return sendJson(res, 500, {
      error: "Failed to test memory query",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ── Other route handlers ────────────────────────────────────────────────────

async function handleStatus(_req, res) {
  const skillsSummary = await loadSkillsSummary();
  sendJson(res, 200, {
    name: "ember-agent-runtime",
    host: HOST,
    port: PORT,
    dataDir: DATA_DIR,
    skillsSummary,
  });
}

async function handleChatStatus(_req, res, url) {
  const conversationId = String(url.searchParams.get("conversationId") || "").trim();
  if (!conversationId) {
    return sendJson(res, 400, { error: "conversationId is required" });
  }
  trimChatProgressStore();
  const state = chatProgressByConversation.get(conversationId);
  if (!state) {
    if (activeChatJobs.has(conversationId)) {
      return sendJson(res, 200, {
        conversationId,
        status: "running",
        startedAt: null,
        updatedAt: null,
        steps: [],
      });
    }
    return sendJson(res, 200, {
      conversationId,
      status: "idle",
      startedAt: null,
      updatedAt: null,
      steps: [],
    });
  }
  return sendJson(res, 200, state);
}

async function handleGetConfig(_req, res) {
  sendJson(res, 200, await loadAgentConfigForUi());
}

async function handleSaveConfig(req, res) {
  try {
    const body = await readJsonBody(req);
    const safeInput = sanitizeConfigInput(body);
    await saveAgentConfigFromUi(safeInput);
    sendJson(res, 200, await loadAgentConfigForUi());
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to save config",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleAuthSources(_req, res) {
  try {
    const sources = await listLocalAuthSources();
    sendJson(res, 200, { sources });
  } catch (error) {
    sendJson(res, 500, {
      error: "Failed to load auth sources",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleCodexOAuthStart(req, res) {
  try {
    const body = await readJsonBody(req);
    const providerId = normalizeProviderId(
      String(body?.providerId || OPENAI_CODEX_PROVIDER_ID).trim() || OPENAI_CODEX_PROVIDER_ID
    );
    const result = await startOAuthFlow(providerId);
    sendJson(res, 200, result);
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    sendJson(res, 500, {
      error: "Failed to start OAuth flow",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleCodexOAuthStatus(req, res, url) {
  const flowId = url.searchParams.get("flowId") || "";
  const result = getFlowStatus(flowId);
  if (result.status === "not_found") {
    return sendJson(res, 404, { error: "OAuth flow not found" });
  }
  // If completed, auto-save tokens to the provider config
  if (result.status === "completed" && result.tokens) {
    try {
      const config = await loadAgentConfigForUi();
      const providerId = normalizeProviderId(result.providerId || OPENAI_CODEX_PROVIDER_ID);
      const providers = Array.isArray(config.providers) ? config.providers : [];
      let matched = false;
      const updatedProviders = providers.map((p) => {
        if (!p || p.id !== providerId) return p;
        matched = true;
        const expiresAt =
          typeof result.tokens.expiresIn === "number"
            ? Date.now() + result.tokens.expiresIn * 1000
            : p.oauthExpiresAt ?? null;
        return {
          ...p,
          authType: "codex-oauth",
          enabled: true,
          apiKey: result.tokens.accessToken,
          oauthRefreshToken: result.tokens.refreshToken || "",
          oauthExpiresAt: expiresAt,
          oauthAccountId: result.tokens.accountId || "",
          oauthIdToken: result.tokens.idToken || "",
        };
      });
      if (!matched) {
        // Add the provider from defaults
        const defaultCodex = DEFAULT_PROVIDERS.find((p) => p.id === providerId) ||
          DEFAULT_PROVIDERS.find((p) => p.id === OPENAI_CODEX_PROVIDER_ID);
        if (defaultCodex) {
          const expiresAt =
            typeof result.tokens.expiresIn === "number"
              ? Date.now() + result.tokens.expiresIn * 1000
              : null;
          updatedProviders.push({
            ...defaultCodex,
            authType: "codex-oauth",
            enabled: true,
            apiKey: result.tokens.accessToken,
            oauthRefreshToken: result.tokens.refreshToken || "",
            oauthExpiresAt: expiresAt,
            oauthAccountId: result.tokens.accountId || "",
            oauthIdToken: result.tokens.idToken || "",
          });
        }
      }
      const updatedConfig = { ...config, providers: updatedProviders };
      await saveAgentConfigFromUi(sanitizeConfigInput(updatedConfig));
    } catch {
      // Non-fatal — tokens are still returned in the response
    }
  }
  return sendJson(res, 200, result);
}

async function handleCodexOAuthCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const flowId = String(body?.flowId || "").trim();
    const redirectUrl = String(body?.redirectUrl || "").trim();
    if (!flowId || !redirectUrl) {
      return sendJson(res, 400, {
        error: "flowId and redirectUrl are required",
      });
    }
    const result = await submitOAuthRedirect(flowId, redirectUrl);
    return sendJson(res, 200, result);
  } catch (error) {
    if (handleBodyErrors(res, error)) return;
    return sendJson(res, 500, {
      error: "Failed to submit OAuth redirect",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleProviderModels(_req, res, providerId) {
  try {
    const config = await loadConfig();
    const providerRegistry = buildProviderRegistry(config);
    const provider = providerRegistry.getProvider(providerId);
    if (!provider) {
      return sendJson(res, 404, { error: "Provider not found" });
    }
    const models = await providerRegistry.listModels(providerId);
    return sendJson(res, 200, {
      providerId,
      models,
      count: models.length,
      selectedModel:
        typeof provider.defaultModel === "string" ? provider.defaultModel : null,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Failed to load provider models",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

// ── Server ──────────────────────────────────────────────────────────────────

async function main() {
  await ensureDataLayout();
  await ensureWorkspaceConfig();
  registry.setSkillDirs([PATHS.skillsTools, toolSkillDir]);
  await loadToolPlugins(registry, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "tools", "plugins"),
    PATHS.tools,
  ]);

  const server = http.createServer((req, res) => {
    if (!req.url) return sendJson(res, 404, { error: "Not found" });
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // Health
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "ember-agent-runtime" });
    }

    // Status
    if (req.method === "GET" && url.pathname === "/status") {
      void handleStatus(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/chat/status") {
      void handleChatStatus(req, res, url);
      return;
    }

    // Config
    if (req.method === "GET" && url.pathname === "/config") {
      void handleGetConfig(req, res);
      return;
    }
    if (
      (req.method === "POST" || req.method === "PUT") &&
      url.pathname === "/config"
    ) {
      void handleSaveConfig(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/sources") {
      void handleAuthSources(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth/codex/oauth") {
      void handleCodexOAuthStart(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth/codex/oauth/code") {
      void handleCodexOAuthCode(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth/codex/oauth/status") {
      void handleCodexOAuthStatus(req, res, url);
      return;
    }
    if (
      req.method === "GET" &&
      parts[0] === "providers" &&
      parts[1] &&
      parts[2] === "models"
    ) {
      void handleProviderModels(req, res, parts[1]);
      return;
    }

    // Chat
    if (req.method === "POST" && url.pathname === "/chat") {
      void handleChat(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/debug/classify") {
      void handleDebugClassify(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/debug/prompt") {
      void handleDebugPrompt(req, res);
      return;
    }

    // Conversations
    if (req.method === "GET" && url.pathname === "/conversations") {
      void handleListConversations(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/conversations") {
      void handleCreateConversation(req, res);
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/conversations") {
      void handleDeleteAllConversations(req, res);
      return;
    }
    if (req.method === "GET" && parts[0] === "conversations" && parts[1]) {
      void handleGetConversation(req, res, parts[1], url);
      return;
    }
    if (req.method === "DELETE" && parts[0] === "conversations" && parts[1]) {
      void handleDeleteConversation(req, res, parts[1]);
      return;
    }
    if (req.method === "PATCH" && parts[0] === "conversations" && parts[1]) {
      void handleUpdateConversation(req, res, parts[1]);
      return;
    }

    // Memories
    if (req.method === "GET" && url.pathname === "/memories") {
      void handleListMemories(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/memories") {
      void handleCreateMemoryRoute(req, res);
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/memories") {
      void handleDeleteAllMemories(req, res);
      return;
    }
    if (req.method === "DELETE" && parts[0] === "memories" && parts[1]) {
      void handleDeleteMemoryRoute(req, res, parts[1]);
      return;
    }
    if (req.method === "PATCH" && parts[0] === "memories" && parts[1]) {
      void handleUpdateMemoryRoute(req, res, parts[1]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/memories/graph") {
      void handleMemoryGraph(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/memories/test-query") {
      void handleTestMemoryQuery(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/memories/summary") {
      void handleMemorySummary(req, res);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `[agent] runtime listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}\n`
    );
    process.stdout.write(`[agent] data dir: ${DATA_DIR}\n`);
  });
  server.on("error", (error) => {
    process.stderr.write(
      `[agent] listen error: ${error instanceof Error ? error.message : "unknown"}\n`
    );
    process.exit(1);
  });

  let serverShuttingDown = false;
  const shutdown = (signal) => {
    if (serverShuttingDown) process.exit(1);
    serverShuttingDown = true;
    process.stdout.write(`[agent] shutting down (${signal})...\n`);
    server.close(() => process.exit(0));
    // Force exit after 2s if server.close() hangs on open connections
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `[agent] fatal: ${error instanceof Error ? error.message : "unknown"}\n`
  );
  process.exit(1);
});
