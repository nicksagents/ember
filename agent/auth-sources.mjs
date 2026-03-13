import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CLAUDE_AUTH_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function maskToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}...`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export async function readCodexAuth() {
  const auth = await readJson(CODEX_AUTH_PATH);
  if (!auth || typeof auth !== "object") return null;
  const accessToken =
    auth?.tokens?.access_token ||
    auth?.tokens?.accessToken ||
    auth?.OPENAI_API_KEY ||
    "";
  const refreshToken =
    auth?.tokens?.refresh_token ||
    auth?.tokens?.refreshToken ||
    "";
  const accountId = auth?.tokens?.account_id || auth?.account_id || "";
  return {
    id: "codex-oauth",
    kind: "codex-oauth",
    label: "Codex OAuth",
    filePath: CODEX_AUTH_PATH,
    available: Boolean(accessToken),
    authMode: typeof auth.auth_mode === "string" ? auth.auth_mode : "",
    accessToken,
    refreshToken,
    accountId,
    lastRefresh:
      typeof auth.last_refresh === "string" ? auth.last_refresh : null,
    tokenPreview: maskToken(accessToken),
  };
}

export async function readClaudeCodeAuth() {
  const auth = await readJson(CLAUDE_AUTH_PATH);
  const oauth = auth?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const accessToken =
    oauth.accessToken ||
    oauth.access_token ||
    "";
  const refreshToken =
    oauth.refreshToken ||
    oauth.refresh_token ||
    "";
  return {
    id: "claude-code-oauth",
    kind: "claude-code-oauth",
    label: "Claude Code OAuth",
    filePath: CLAUDE_AUTH_PATH,
    available: Boolean(accessToken),
    accessToken,
    refreshToken,
    expiresAt:
      typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    subscriptionType:
      typeof oauth.subscriptionType === "string"
        ? oauth.subscriptionType
        : "",
    rateLimitTier:
      typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : "",
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.map(String) : [],
    tokenPreview: maskToken(accessToken),
  };
}

export async function listLocalAuthSources() {
  const [codex, claude] = await Promise.all([
    readCodexAuth(),
    readClaudeCodeAuth(),
  ]);
  return [codex, claude]
    .filter(Boolean)
    .map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      available: Boolean(source.available),
      tokenPreview: source.tokenPreview || "",
      expiresAt: source.expiresAt || null,
      authMode: source.authMode || "",
      subscriptionType: source.subscriptionType || "",
      rateLimitTier: source.rateLimitTier || "",
      scopes: Array.isArray(source.scopes) ? source.scopes : [],
      lastRefresh: source.lastRefresh || null,
    }));
}

export async function resolveProviderApiKey(provider) {
  const authType = String(provider?.authType || "api-key").trim();
  if (!provider || authType === "none") return "";

  const storedToken = String(provider?.apiKey || "").trim();

  if (authType === "env") {
    const envVar = String(provider?.apiKeyEnvVar || "").trim();
    return envVar ? String(process.env[envVar] || "").trim() : "";
  }

  if (authType === "codex-oauth") {
    return storedToken;
  }

  if (authType === "claude-code-oauth") {
    return storedToken;
  }

  return storedToken;
}

export function describeProviderAuth(provider) {
  const authType = String(provider?.authType || "api-key").trim();
  if (authType === "none") return "No auth";
  if (authType === "env") {
    return provider?.apiKeyEnvVar
      ? `Env: ${provider.apiKeyEnvVar}`
      : "Environment variable";
  }
  if (authType === "codex-oauth") {
    return provider?.apiKey ? "Agent-managed Codex OAuth token" : "Codex OAuth";
  }
  if (authType === "claude-code-oauth") {
    return provider?.apiKey
      ? "Agent-managed Anthropic setup-token"
      : "Anthropic setup-token";
  }
  return provider?.apiKey ? "Manual API key" : "Manual API key";
}
