import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { PROVIDER_LIBRARY, normalizeProviderId } from "@/lib/config";

const AGENT_URL = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";
const DEFAULT_CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const DEFAULT_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CODEX_CLIENT_ID =
  "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_STATE_COOKIE = "ember_codex_oauth_state";

type OAuthState = {
  state: string;
  providerId: string;
  returnTo: string;
  codeVerifier: string;
};

function base64UrlEncode(value: Buffer) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createPkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(64));
  const challenge = base64UrlEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
  };
}

export function getCodexOauthConfig(req: NextRequest) {
  const authUrl = process.env.EMBER_CODEX_OAUTH_AUTH_URL || DEFAULT_CODEX_AUTH_URL;
  const tokenUrl = process.env.EMBER_CODEX_OAUTH_TOKEN_URL || DEFAULT_CODEX_TOKEN_URL;
  const clientId = process.env.EMBER_CODEX_OAUTH_CLIENT_ID || DEFAULT_CODEX_CLIENT_ID;
  const scope =
    process.env.EMBER_CODEX_OAUTH_SCOPE ||
    "openid profile email offline_access";
  const redirectUri =
    process.env.EMBER_CODEX_OAUTH_REDIRECT_URI ||
    new URL("/api/auth/codex/callback", req.nextUrl.origin).toString();

  return {
    authUrl,
    tokenUrl,
    clientId,
    scope,
    redirectUri,
    configured: true,
  };
}

export function parseOAuthState(raw: string) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OAuthState;
    if (!parsed?.state || !parsed?.providerId || !parsed?.codeVerifier) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function serializeOAuthState(state: OAuthState) {
  return JSON.stringify(state);
}

export async function loadAgentConfig() {
  const response = await fetch(`${AGENT_URL}/config`, { cache: "no-store" });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.details || data?.error || "Failed to load agent config");
  }
  return data;
}

export async function saveAgentConfig(config: unknown) {
  const response = await fetch(`${AGENT_URL}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.details || data?.error || "Failed to save agent config");
  }
  return data;
}

export async function exchangeOAuthCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
}) {
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload?.error_description ||
        payload?.error ||
        `OAuth token exchange failed (${response.status})`
    );
  }
  return payload;
}

export function decodeJwtPayload(token: string) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const base64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function upsertProviderToken(
  config: Record<string, unknown>,
  input: {
    providerId: string;
    apiKey: string;
    authType?: string;
    refreshToken?: string;
    expiresIn?: number | null;
    accountId?: string;
    idToken?: string;
  }
) {
  const providerId = normalizeProviderId(input.providerId);
  const resolvedAuthType = input.authType || "codex-oauth";
  const providerTemplate =
    PROVIDER_LIBRARY.find((entry) => entry.id === providerId)?.provider ||
    PROVIDER_LIBRARY.find((entry) => entry.id === "openai-codex")?.provider ||
    null;
  let matched = false;
  const next = {
    ...config,
    providers: Array.isArray(config.providers)
      ? config.providers.map((provider) => {
          if (!provider || typeof provider !== "object") return provider;
          if (normalizeProviderId((provider as { id?: string }).id || "") !== providerId) {
            return provider;
          }
          matched = true;
          const expiresAt =
            typeof input.expiresIn === "number"
              ? Date.now() + input.expiresIn * 1000
              : (provider as { oauthExpiresAt?: number | null }).oauthExpiresAt ?? null;
          return {
            ...provider,
            id: providerId,
            authType: resolvedAuthType,
            enabled: true,
            apiKey: input.apiKey,
            oauthRefreshToken: input.refreshToken || "",
            oauthExpiresAt: expiresAt,
            oauthAccountId: input.accountId || "",
            oauthIdToken: input.idToken || "",
          };
        })
      : [],
  };
  if (!matched && providerTemplate) {
    const expiresAt =
      typeof input.expiresIn === "number" ? Date.now() + input.expiresIn * 1000 : null;
    next.providers = [
      ...(Array.isArray(next.providers) ? next.providers : []),
      {
        ...providerTemplate,
        id: providerId,
        authType: resolvedAuthType,
        enabled: true,
        apiKey: input.apiKey,
        oauthRefreshToken: input.refreshToken || "",
        oauthExpiresAt: expiresAt,
        oauthAccountId: input.accountId || "",
        oauthIdToken: input.idToken || "",
      },
    ];
  }
  return next;
}

export function buildSettingsRedirect(
  req: NextRequest,
  returnTo: string,
  params: Record<string, string>
) {
  const url = new URL(returnTo || "/settings", req.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}
