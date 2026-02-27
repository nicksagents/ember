#!/usr/bin/env node

import http from "node:http";
import os from "node:os";
import path from "node:path";
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
  detectMemoryInvalidations,
  buildEmbedding,
  consolidateMemories,
  selectMemoriesWithFallback,
} from "./core.mjs";
import {
  ToolRegistry,
  registerFilesystemTools,
  loadToolPlugins,
  createFsPolicy,
} from "./tooling.mjs";

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
const SUMMARY_KEEP_MESSAGES = 16;
const SUMMARY_MIN_MESSAGES = 6;
const SUMMARY_MAX_INPUT_CHARS = 6000;
const SUMMARY_MAX_OUTPUT_CHARS = 800;
const CONTEXT_CHAR_BUDGET = 18000;
const CHAT_PROGRESS_TTL_MS = 15 * 60 * 1000;
const CHAT_PROGRESS_MAX_STEPS = 60;

const chatProgressByConversation = new Map();

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

const DEFAULT_CONFIG = {
  provider: "custom",
  endpoint: "http://localhost:8080/v1/chat/completions",
  model: "",
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  min_p: 0.05,
  repetition_penalty: 1.05,
  max_tokens: 2048,
  statelessProvider: true,
  lightweightMode: true,
  maxToolRounds: 20,
  unrestrictedShell: false,
  webSearchEnabled: true,
  workspaceRoot: getWorkspaceDefaults().workspaceRoot,
  desktopDir: getWorkspaceDefaults().desktopDir,
  homeDir: getWorkspaceDefaults().homeDir,
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

const DEFAULT_CORE_PROMPT = [
  "You are Ember, a local coding assistant.",
  "Always execute tasks using tools. Never describe what you would do - do it.",
  "If a task requires multiple steps, keep calling tools until every step is complete.",
  "When a tool fails, retry with corrected arguments or explain the error.",
  "Save memories only for durable user preferences or identity facts.",
].join("\n");
const DEFAULT_SOUL_MD = "You are funny, concise, and helpful.";

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

async function loadConfig(overrides) {
  const raw = await readText(PATHS.config, "{}");
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const workspaceDefaults = getWorkspaceDefaults();
  return {
    ...DEFAULT_CONFIG,
    ...workspaceDefaults,
    ...parsed,
    modelRoles: {
      ...DEFAULT_CONFIG.modelRoles,
      ...(parsed.modelRoles || {}),
    },
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
    `${JSON.stringify(
      {
        provider: nextConfig.provider,
        endpoint: nextConfig.endpoint,
        model: nextConfig.model,
        temperature: nextConfig.temperature,
        top_p: nextConfig.top_p,
        top_k: nextConfig.top_k,
        min_p: nextConfig.min_p,
        repetition_penalty: nextConfig.repetition_penalty,
        max_tokens: nextConfig.max_tokens,
        statelessProvider: Boolean(nextConfig.statelessProvider),
        unrestrictedShell: Boolean(nextConfig.unrestrictedShell),
        webSearchEnabled: Boolean(nextConfig.webSearchEnabled),
        modelRoles: nextConfig.modelRoles,
        lightweightMode: Boolean(nextConfig.lightweightMode),
        maxToolRounds: Number.isFinite(nextConfig.maxToolRounds)
          ? nextConfig.maxToolRounds
          : DEFAULT_CONFIG.maxToolRounds,
        workspaceRoot: nextConfig.workspaceRoot,
        desktopDir: nextConfig.desktopDir,
        homeDir: nextConfig.homeDir,
        githubUsername: nextConfig.githubUsername || "",
        githubEmail: nextConfig.githubEmail || "",
        githubToken: nextConfig.githubToken || "",
      },
      null,
      2
    )}\n`,
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
  };

  await writeFile(
    PATHS.config,
    `${JSON.stringify(
      {
        provider: nextConfig.provider,
        endpoint: nextConfig.endpoint,
        model: nextConfig.model,
        temperature: nextConfig.temperature,
        top_p: nextConfig.top_p,
        top_k: nextConfig.top_k,
        min_p: nextConfig.min_p,
        repetition_penalty: nextConfig.repetition_penalty,
        max_tokens: nextConfig.max_tokens,
        statelessProvider: Boolean(nextConfig.statelessProvider),
        unrestrictedShell: Boolean(nextConfig.unrestrictedShell),
        webSearchEnabled: Boolean(nextConfig.webSearchEnabled),
        modelRoles: nextConfig.modelRoles,
        lightweightMode: Boolean(nextConfig.lightweightMode),
        maxToolRounds: Number.isFinite(nextConfig.maxToolRounds)
          ? nextConfig.maxToolRounds
          : DEFAULT_CONFIG.maxToolRounds,
        workspaceRoot: nextConfig.workspaceRoot,
        desktopDir: nextConfig.desktopDir,
        homeDir: nextConfig.homeDir,
        githubUsername: nextConfig.githubUsername || "",
        githubEmail: nextConfig.githubEmail || "",
        githubToken: nextConfig.githubToken || "",
      },
      null,
      2
    )}\n`,
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

async function appendToConversation(id, role, content) {
  const record = { ts: new Date().toISOString(), role, content };
  const filePath = conversationFilePath(id);
  await withFileLock(filePath, () =>
    appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8")
  );
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
  let results = all;
  if (tags && tags.length > 0) {
    results = results.filter((m) =>
      tags.some((t) => m.tags?.includes(t))
    );
  }
  if (query) {
    const q = query.toLowerCase();
    results = results.filter((m) =>
      m.content.toLowerCase().includes(q)
    );
  }
  return results;
}

async function createMemory(content, tags, source, meta = {}) {
  const normalized = typeof content === "string" ? content.trim() : "";
  if (!normalized) {
    return { id: null, duplicate: false, saved: false };
  }

  const existing = await loadAllMemories();
  const recent = existing.slice(-200);
  const normalizedLower = normalized.toLowerCase();
  const duplicate = recent.find(
    (m) =>
      typeof m.content === "string" &&
      m.content.trim().toLowerCase() === normalizedLower
  );
  if (duplicate) {
    return { id: duplicate.id, duplicate: true, saved: false };
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
    typeof meta.approved === "boolean" ? meta.approved : confirmed;

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
  const content = filtered.length
    ? filtered.map((m) => JSON.stringify(m)).join("\n") + "\n"
    : "";
  await withFileLock(PATHS.memoriesIndex, () =>
    writeFile(PATHS.memoriesIndex, content, "utf8")
  );
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
  const nextConfidence = Math.max(0.2, mem.confidence * decay);
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
  const activeModel = config?.modelRoles?.assistant || config?.model;
  if (activeModel) payload.model = activeModel;

  try {
    const response = await fetchWithTimeout(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return existingSummary || "";
    const data = await response.json();
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
  true;
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
      const title = contentType.includes("html") ? extractHtmlTitle(body) : "";
      const text = (contentType.includes("html") ? stripHtmlToText(body) : body.trim()).slice(
        0,
        maxChars
      );
      return {
        url: targetUrl,
        title,
        contentType,
        text,
        truncated: text.length >= maxChars,
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

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|article|section|li|h1|h2|h3|h4|h5|h6|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1]).trim() : "";
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

function looksLikeServerTaskRequest(userContent) {
  const text = String(userContent || "").toLowerCase();
  return (
    /\b(server|dev server|development server|localhost|0\.0\.0\.0|127\.0\.0\.1|port\s+\d{2,5})\b/.test(
      text
    ) ||
    /\bnpm run dev\b/.test(text)
  );
}

function classifyProcessTask(userContent) {
  if (!looksLikeServerTaskRequest(userContent)) return null;
  const text = String(userContent || "").toLowerCase();
  const port = extractRequestedPort(userContent, 3000);
  const host = extractRequestedHost(userContent, "0.0.0.0");

  const isStop =
    /\b(kill|stop|shutdown|shut down|terminate|end|close)\b/.test(text) ||
    /\bfree up\b/.test(text);
  const isRestart =
    /\b(restart|reboot|reload|relaunch)\b/.test(text) ||
    (/\bstart\b/.test(text) && isStop);
  const isVerify =
    /\b(verify|check|confirm|is it running|make sure)\b/.test(text) &&
    !/\b(start|run|host|serve|launch)\b/.test(text);
  const isStart =
    /\b(start|run|host|serve|launch|boot)\b/.test(text) ||
    /\bnpm run dev\b/.test(text);

  let intent = "inspect";
  if (isRestart) intent = "restart";
  else if (isStop) intent = "stop";
  else if (isStart) intent = "start";
  else if (isVerify) intent = "verify_up";

  return { intent, host, port };
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

function extractRequestedPort(userContent, fallback = 3000) {
  const text = String(userContent || "");
  const match =
    text.match(/\bport\s+(\d{2,5})\b/i) ||
    text.match(/:(\d{2,5})\b/) ||
    text.match(/\bon\s+(\d{2,5})\b/i);
  const port = Number.parseInt(match?.[1] || "", 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function extractRequestedHost(userContent, fallback = "0.0.0.0") {
  const text = String(userContent || "").toLowerCase();
  if (text.includes("0.0.0.0")) return "0.0.0.0";
  if (text.includes("127.0.0.1")) return "127.0.0.1";
  if (text.includes("localhost")) return "127.0.0.1";
  return fallback;
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

function inferServerStartCommand(userContent) {
  const text = String(userContent || "").toLowerCase();
  if (text.includes("pnpm")) return "pnpm dev";
  if (text.includes("yarn")) return "yarn dev";
  if (text.includes("bun")) return "bun run dev";
  if (text.includes("npm run start")) return "npm run start";
  return "npm run dev";
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
        toolByCallId.set(id, name);
        usedNames.push(name);
      }
      continue;
    }
    if (msg?.role === "tool" && msg.tool_call_id) {
      const name = toolByCallId.get(msg.tool_call_id);
      if (!name) continue;
      try {
        lastResultByName.set(name, JSON.parse(msg.content || "{}"));
      } catch {
        lastResultByName.set(name, {});
      }
    }
  }
  return {
    usedNames,
    hasUsed(name) {
      return usedNames.includes(name);
    },
    lastResult(name) {
      return lastResultByName.get(name);
    },
  };
}

function buildServerCompletionGuard(userContent) {
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

async function handleChat(req, res) {
  let activeConversationId = "";
  try {
    const body = await readJsonBody(req);
    const validation = validateChatRequest(body);
    if (!validation.ok) {
      return sendJson(res, 400, { error: validation.errors.join(", ") });
    }
    const { conversationId, content: userContent } = validation.data;
    activeConversationId = conversationId;
    await logEvent("chat_request", {
      conversationId,
      content: userContent,
    });
    updateChatProgress(conversationId, "running", "Queued request");

    const config = await loadConfig(sanitizeConfigInput(body.config));
    fsPolicy.unrestrictedShell = Boolean(config.unrestrictedShell);

    // Load conversation history from disk
    const history = await loadConversationMessages(conversationId);

    // Append user message to conversation file
    await appendToConversation(conversationId, "user", userContent);

    // Build context with structured summary compression
    updateChatProgress(conversationId, "running", "Preparing context");
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
    while (
      totalChars > CONTEXT_CHAR_BUDGET &&
      contextMessages.length > 2
    ) {
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
    const candidates = detectMemoryCandidates(userContent, memories, 3);
    const createdMemories = [];
    if (candidates.length > 0) {
      for (const candidate of candidates) {
        const created = await createMemory(
          candidate.content,
          candidate.tags,
          { conversationId, messageTs: new Date().toISOString() },
          { type: candidate.type, confidence: candidate.confidence, confirmed: false }
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
    const relevantMemories = isShortFollowUp
      ? []
      : selectMemoriesWithFallback(usableMemories, combinedQuery, 5, {
          maxPinned: 2,
          maxAgeDays: 180,
          referenceMaxAgeDays: 45,
          minScore: 1,
        });
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
    });

    const isWebLookup = Boolean(config.webSearchEnabled) && looksLikeWebLookupRequest(userContent);
    const processTask = classifyProcessTask(userContent);

    const requiresTool = (() => {
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
      if (processTask) return true;
      if (/\b(?:create|build|scaffold|set\s*up|initialize|init)\s+(?:a\s+)?(?:new\s+)?(?:project|app|application|website|site|repo|repository)\b/.test(text)) return true;
      if (/\b(?:install|add|remove|uninstall)\s+\w/.test(text) && /\b(?:package|dependency|dep|lib|library|module|shadcn|tailwind|prisma|next|react|vue|express)\b/.test(text)) return true;
      if (/\b(?:fix|update|change|modify|edit|refactor|debug)\s+(?:the\s+|my\s+|this\s+)?(?:code|bug|error|issue|style|styling|layout|page|component|function|api|route|config)\b/.test(text)) return true;
      if (/\b(?:add|create|implement|build)\s+(?:a\s+|an\s+|the\s+)?(?:page|component|feature|form|button|modal|sidebar|navbar|header|footer|api|route|endpoint|test)\b/.test(text)) return true;
      if (/\b(?:show|check|review)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current)\s+(?:changes|status)\b/.test(text)) return true;
      if (/\b(?:deploy|push|publish|upload|host)\b/.test(text)) return true;
      if (/\bnpx?\s+\w/.test(text)) return true;
      if (isWebLookup) return true;
      // Path-like patterns (e.g., "/home/user/file.txt", "~/Desktop", "./src")
      if (/(?:^|\s)[~.]?\/\w/.test(text)) return true;
      return false;
    })();

    const isGitRequest = (() => {
      const text = userContent.toLowerCase();
      return /\b(git|github|repo|repository|commit|push|pull|clone|branch)\b/.test(
        text
      );
    })();

    const isReadOnlyFsRequest = (() => {
      const text = userContent.toLowerCase();
      const readish =
        /\b(?:list|show|what'?s?\s+in|whats?\s+in|read|open|view|stat|exists)\b/.test(
          text
        );
      const writeish =
        /\b(?:create|make|write|save|delete|remove|move|rename|copy|mkdir|rmdir|touch)\b/.test(
          text
        );
      return readish && !writeish;
    })();
    const isPureWebLookup =
      isWebLookup &&
      !processTask &&
      !isGitRequest &&
      !/\b(?:file|folder|directory|desktop|home|terminal|shell|command|script|git|repo|repository|server|port)\b/.test(
        userContent.toLowerCase()
      );

    const fallbackToolCall = async (_message, _payload, options = {}) => {
      if (!requiresTool) return null;
      const text = userContent.toLowerCase();
      const home = config.homeDir || os.homedir();
      const desktop = config.desktopDir || path.join(home, "Desktop");
      const phase = options?.phase || "execute";

      const wantsDesktop = text.includes("desktop");
      const listLike =
        text.includes("list") ||
        text.includes("what's in") ||
        text.includes("whats in") ||
        (text.includes("show") && /\b(?:folder|directory|desktop|home|files?)\b/.test(text));
      const readLike = text.includes("read") || text.includes("open");
      const makeDirLike =
        text.includes("mkdir") ||
        text.includes("make folder") ||
        text.includes("create folder") ||
        text.includes("create directory") ||
        text.includes("make directory");
      const deleteLike =
        text.includes("delete") || text.includes("remove") || text.includes("rm ");
      const moveLike =
        text.includes("move") || text.includes("rename") || text.includes("mv ");
      const copyLike = text.includes("copy") || text.includes("cp ");
      const repoStatusLike =
        /\b(?:show|check|review)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current)\s+(?:changes|status)\b/.test(text) ||
        /\bgit\s+(?:status|diff|log)\b/.test(text);

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

      if (processTask) {
        const cwd = inferProjectDirectory(userContent, config);
        const { host, port, intent } = processTask;
        const loopState = inspectToolLoopMessages(_payload?.messages || []);
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
              command: inferServerStartCommand(userContent),
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

      if (listLike) {
        return { name: "list_dir", arguments: { path: home } };
      }

      if (readLike) {
        const fileMatch = userContent.match(/(?:read|open)\s+([\w./-]+)\b/i);
        if (fileMatch) {
          const target = fileMatch[1];
          const fullPath = path.isAbsolute(target) ? target : path.join(home, target);
          return { name: "read_file", arguments: { path: fullPath } };
        }
      }

      if (repoStatusLike) {
        const workspaceRoot = config.workspaceRoot || process.cwd();
        return {
          name: "run_command",
          arguments: { command: `git -C "${workspaceRoot}" status --short` },
        };
      }

      if (deleteLike || moveLike || copyLike) {
        return null;
      }
      return null;
    };

    // No hard-coded tool execution here; rely on model + tool loop.

    const fullMessages = [
      { role: "system", content: systemMessage },
      ...contextMessages,
    ];

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
    if (typeof config.min_p === "number" && config.min_p > 0) {
      payload.min_p = config.min_p;
    }

    const activeModel = config.modelRoles?.assistant || config.model;
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
    const allToolDefs = registry.getDefinitions();
    const toolDefs = isPureWebLookup
      ? allToolDefs.filter((tool) =>
          ["web_search", "fetch_url"].includes(tool?.function?.name || "")
        )
      : allToolDefs;
    const isConversational =
      !requiresTool &&
      !isWebLookup &&
      !isGitRequest &&
      !processTask &&
      userContent.trim().length < 100 &&
      !/\b(?:install|build|create|make|run|start|stop|deploy|fix|update|add|delete|remove|write|read|open|save)\b/i.test(
        userContent
      );

    if (toolDefs.length > 0 && !isConversational) {
      payload.tools = toolDefs;
    }
    await logEvent("tools_available", {
      conversationId,
      toolCount: toolDefs.length,
      tools: toolDefs.map((t) => t.function?.name).filter(Boolean),
    });

    // Call LLM
    let llmCallCount = 0;
    const callLLM = async (nextPayload) => {
      llmCallCount += 1;
      updateChatProgress(
        conversationId,
        "running",
        `LLM call ${llmCallCount}: waiting for model`
      );
      try {
        const upstream = await fetchWithTimeout(
          config.endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextPayload),
          },
          120_000
        );
        if (!upstream.ok) {
          const errorText = await upstream.text();
          throw new Error(`LLM server error: ${upstream.status} ${errorText}`);
        }
        const data = await upstream.json();
        await logEvent("llm_response", {
          conversationId,
          response: JSON.stringify(data).slice(0, 8000),
        });
        updateChatProgress(
          conversationId,
          "running",
          `LLM call ${llmCallCount}: response received`
        );
        return data;
      } catch (error) {
        updateChatProgress(
          conversationId,
          "running",
          `LLM call ${llmCallCount}: failed (${error instanceof Error ? error.message : "unknown error"})`
        );
        throw error;
      }
    };

    const systemNotes = [];
    if (requiresTool) {
      systemNotes.push(
        "Execute using tools now. Do not describe what you would do - do it. " +
        "Use the 3-layer workflow: 1) understand, 2) execute with tools, 3) verify with tools. " +
        "Do not claim success without tool verification."
      );
    }
    if (requiresTool && processTask) {
      systemNotes.push(
        processTask.intent === "stop"
          ? "This is a process-stop task. Use list_processes and kill_process. Verify port is free before responding."
          : "This is a server task. Use start_dev_server and verify_server. A PID alone is not enough."
      );
    }
    if (isWebLookup) {
      systemNotes.push(
        "Use web_search immediately with a small result set. For simple lookup questions, one quick search is usually enough. Only use fetch_url when the snippets are insufficient or a URL was provided. Do not use local shell or filesystem tools for a pure web lookup."
      );
    }
    if (requiresTool && isGitRequest) {
      systemNotes.push("Use github_repo and run_command for git operations. Verify with git ls-remote.");
    }
    if (systemNotes.length > 0) {
      payload.messages.push({
        role: "user",
        content: `[System note] ${systemNotes.join(" ")}`,
      });
    }

    const configuredMaxRounds =
      typeof config.maxToolRounds === "number"
        ? config.maxToolRounds
        : DEFAULT_CONFIG.maxToolRounds;
    const effectiveMaxRounds = requiresTool
      ? Math.min(configuredMaxRounds, isGitRequest ? 15 : isReadOnlyFsRequest ? 5 : 10)
      : 8;
    const maxToolRounds = isPureWebLookup
      ? Math.min(effectiveMaxRounds, 3)
      : effectiveMaxRounds;
    const completionGuard = buildServerCompletionGuard(userContent);
    const buildVerifyPrompt = isPureWebLookup
      ? ({ hasErrors, toolCalls, defaultPrompt }) => {
          if (hasErrors) return defaultPrompt;
          const toolNames = (Array.isArray(toolCalls) ? toolCalls : [])
            .map((toolCall) => toolCall?.function?.name)
            .filter(Boolean);
          if (toolNames.includes("fetch_url")) {
            return "[System note] Use the fetched page text to answer the user now. Only fetch another page if this page is clearly insufficient.";
          }
          if (toolNames.includes("web_search")) {
            return "[System note] Use these search results to answer the user now. Only call fetch_url if one result needs more detail.";
          }
          return defaultPrompt;
        }
      : null;
    const toolCallGuard = isPureWebLookup
      ? ({ payload: nextPayload, message }) => {
          const requestedToolNames = (Array.isArray(message?.tool_calls) ? message.tool_calls : [])
            .map((toolCall) => toolCall?.function?.name)
            .filter(Boolean);
          if (requestedToolNames.length === 0) return null;

          const loopState = inspectToolLoopMessages(nextPayload?.messages || []);
          const usedNames = Array.isArray(loopState?.usedNames) ? loopState.usedNames : [];
          const webSearchCount = usedNames.filter((name) => name === "web_search").length;
          const fetchUrlCount = usedNames.filter((name) => name === "fetch_url").length;

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
      : null;

    const { assistantContent } = await runToolLoop({
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
          describeToolProgress(name, args, null, "running")
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
            : describeToolProgress(name, args, result, "done")
        );
        return result;
      },
      toolSkillLoader: (name) => registry.getSkill(name),
      preToolSkillInjection: false,
      verifyToolResults: true,
      requireToolCall: requiresTool,
      fallbackToolCall,
      directToolOutput: requiresTool && isReadOnlyFsRequest,
      maxToolRounds,
      completionGuard,
      buildVerifyPrompt,
      toolCallGuard,
    });
    await logEvent("assistant_response", { conversationId, content: assistantContent });
    updateChatProgress(conversationId, "running", "Assistant response ready");

    // Save assistant response to conversation
    await appendToConversation(conversationId, "assistant", assistantContent);

    const assistantFacts = detectAssistantFacts(assistantContent, memories, 2);
    if (assistantFacts.length > 0) {
      for (const fact of assistantFacts) {
        await createMemory(
          fact.content,
          fact.tags,
          { conversationId, messageTs: new Date().toISOString() },
          { type: fact.type, confidence: fact.confidence, confirmed: false }
        );
      }
    }

    // Update manifest metadata
    const manifest = await loadManifest();
    const conv = manifest.conversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.updatedAt = new Date().toISOString();
      conv.messageCount = (conv.messageCount || 0) + 2;
      // Auto-title from first user message
      if (conv.title === "New conversation" && history.length === 0) {
        conv.title =
          userContent.length > 50
            ? `${userContent.substring(0, 47)}...`
            : userContent;
      }
      await saveManifest(manifest);
    }

    sendJson(res, 200, { content: assistantContent });
    updateChatProgress(conversationId, "completed", "Response sent");

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
  } catch (error) {
    if (activeConversationId) {
      updateChatProgress(
        activeConversationId,
        "failed",
        `Request failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    if (handleBodyErrors(res, error)) return;
    await logEvent("chat_error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return sendJson(res, 504, { error: "LLM request timed out" });
      }
      if (error.message.startsWith("LLM server error")) {
        return sendJson(res, 502, { error: error.message });
      }
    }
    sendJson(res, 500, {
      error: "Agent runtime failure",
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
  sendJson(res, 200, { memories: results.slice(-limit) });
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
  const nodes = memories.slice(-maxNodes).map((m) => {
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

  const keyForEmbedding = (embedding) => {
    if (!Array.isArray(embedding) || embedding.length === 0) return "0";
    let key = 0;
    const len = Math.min(16, embedding.length);
    for (let i = 0; i < len; i += 1) {
      if (embedding[i] >= 0) key |= 1 << i;
    }
    return String(key);
  };

  const embeddingById = new Map();
  for (const mem of memories.slice(-maxNodes)) {
    embeddingById.set(mem.id, mem.embedding || buildEmbedding(mem.content || ""));
  }

  const buckets = new Map();
  for (const mem of memories.slice(-maxNodes)) {
    const key = keyForEmbedding(embeddingById.get(mem.id));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(mem);
  }

  const links = [];
  const maxLinksPerNode = 2;
  const similarityThreshold = 0.72;

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      const a = bucket[i];
      const aEmbed = embeddingById.get(a.id);
      let added = 0;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const b = bucket[j];
        const bEmbed = embeddingById.get(b.id);
        const sim = (() => {
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let k = 0; k < aEmbed.length; k += 1) {
            dot += aEmbed[k] * bEmbed[k];
            normA += aEmbed[k] * aEmbed[k];
            normB += bEmbed[k] * bEmbed[k];
          }
          if (normA === 0 || normB === 0) return 0;
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        })();
        if (sim >= similarityThreshold) {
          links.push({ source: a.id, target: b.id, weight: Number(sim.toFixed(3)) });
          added += 1;
        }
        if (added >= maxLinksPerNode) break;
      }
    }
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
  await deleteMemory(id);
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
    const activeModel = config.modelRoles?.assistant || config.model;
    if (activeModel) payload.model = activeModel;

    const response = await fetchWithTimeout(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errorText = await response.text();
      return sendJson(res, 502, { error: "Summary model error", details: errorText });
    }

    const data = await response.json();
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

    // Chat
    if (req.method === "POST" && url.pathname === "/chat") {
      void handleChat(req, res);
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
