/**
 * Codex (OpenAI) OAuth flow for the Ember agent runtime.
 *
 * This now matches the working OpenClaw/T560 contract:
 *   1. Use the fixed OpenAI callback URI at http://127.0.0.1:1455/auth/callback
 *   2. Open the browser auth URL with PKCE
 *   3. Capture the redirect locally when possible
 *   4. If the callback fails to land, accept the pasted redirect URL manually
 *   5. Exchange the auth code for tokens via PKCE
 *   6. Store tokens in the provider config
 */

import http from "node:http";
import crypto from "node:crypto";

const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPES = "openid profile email offline_access";
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CALLBACK_HOST = "localhost";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Active OAuth flows keyed by flowId
const activeFlows = new Map();

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const b64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><title>Ember - OpenAI Connected</title>
<style>body{background:#09090b;color:#e4e4e7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;max-width:400px;padding:2rem}
h1{font-size:1.25rem;margin-bottom:.5rem}
p{font-size:.875rem;color:#a1a1aa}
.ok{color:#34d399;font-size:2rem;margin-bottom:1rem}</style></head>
<body><div class="card"><div class="ok">&#10003;</div>
<h1>OpenAI connected to Ember</h1>
<p>You can close this tab and return to Ember settings.</p>
</div></body></html>`;

const ERROR_HTML = (msg) => `<!DOCTYPE html>
<html><head><title>Ember - Auth Error</title>
<style>body{background:#09090b;color:#e4e4e7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;max-width:400px;padding:2rem}
h1{font-size:1.25rem;margin-bottom:.5rem;color:#f87171}
p{font-size:.875rem;color:#a1a1aa}</style></head>
<body><div class="card"><h1>Authentication failed</h1>
<p>${msg}</p></div></body></html>`;

export function getCodexCallbackUrl() {
  return CALLBACK_URL;
}

function buildAuthUrl({ state, challenge }) {
  const authUrl = new URL(OPENAI_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CODEX_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", CALLBACK_URL);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  return authUrl.toString();
}

function getFlow(flowId) {
  const flow = activeFlows.get(flowId);
  if (!flow) {
    throw new Error("OAuth flow not found");
  }
  return flow;
}

function scheduleTimeout(flowId) {
  return setTimeout(() => {
    const flow = activeFlows.get(flowId);
    if (!flow || flow.status !== "pending") return;
    flow.status = "error";
    flow.error = "OAuth flow timed out (5 minutes)";
    cleanupFlow(flowId);
  }, FLOW_TIMEOUT_MS);
}

export function parseCodexRedirectUrl(redirectUrl) {
  const raw = String(redirectUrl || "").trim();
  if (!raw) {
    throw new Error("Missing redirect URL");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Redirect URL is invalid");
  }
  const pathname = parsed.pathname || "";
  const hostname = (parsed.hostname || "").toLowerCase();
  if (!pathname.endsWith(CALLBACK_PATH)) {
    throw new Error(`Expected redirect URL ending in ${CALLBACK_PATH}`);
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error("Redirect URL must target localhost:1455/auth/callback");
  }
  return {
    raw,
    code: parsed.searchParams.get("code") || "",
    state: parsed.searchParams.get("state") || "",
    error: parsed.searchParams.get("error") || "",
    errorDescription: parsed.searchParams.get("error_description") || "",
  };
}

async function exchangeAuthorizationCode(flow, code) {
  const tokenRes = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK_URL,
      client_id: CODEX_CLIENT_ID,
      code_verifier: flow.verifier,
    }),
  });

  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenData) {
    throw new Error(
      tokenData?.error_description ||
        tokenData?.error ||
        `Token exchange failed (${tokenRes.status})`
    );
  }

  const accessToken = String(
    tokenData.access_token || tokenData.accessToken || ""
  ).trim();
  const refreshToken = String(
    tokenData.refresh_token || tokenData.refreshToken || ""
  ).trim();
  const idToken = String(
    tokenData.id_token || tokenData.idToken || ""
  ).trim();
  const expiresIn = Number(tokenData.expires_in ?? tokenData.expiresIn ?? NaN);

  if (!accessToken) {
    throw new Error("OpenAI did not return an access token");
  }

  const jwtPayload = decodeJwtPayload(idToken || accessToken);
  const authClaim = jwtPayload?.["https://api.openai.com/auth"];
  const accountId = String(
    tokenData.account_id ||
      authClaim?.chatgpt_account_id ||
      jwtPayload?.sub ||
      ""
  ).trim();

  return {
    accessToken,
    refreshToken,
    idToken,
    accountId,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : null,
  };
}

async function completeOAuthFlow(flow, params) {
  if (flow.status !== "pending") {
    return {
      status: flow.status,
      tokens: flow.tokens,
      error: flow.error,
      providerId: flow.providerId,
    };
  }

  if (params.error) {
    flow.status = "error";
    flow.error = params.errorDescription || params.error;
    cleanupFlow(flow.id);
    return {
      status: flow.status,
      tokens: null,
      error: flow.error,
      providerId: flow.providerId,
    };
  }

  if (!params.code || !params.state || params.state !== flow.state) {
    flow.status = "error";
    flow.error = "Invalid callback — state mismatch or missing code";
    cleanupFlow(flow.id);
    return {
      status: flow.status,
      tokens: null,
      error: flow.error,
      providerId: flow.providerId,
    };
  }

  try {
    flow.tokens = await exchangeAuthorizationCode(flow, params.code);
    flow.status = "completed";
    cleanupFlow(flow.id);
    return {
      status: flow.status,
      tokens: flow.tokens,
      error: null,
      providerId: flow.providerId,
    };
  } catch (error) {
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : "Token exchange failed";
    cleanupFlow(flow.id);
    return {
      status: flow.status,
      tokens: null,
      error: flow.error,
      providerId: flow.providerId,
    };
  }
}

/**
 * Start a new OAuth flow.
 * Returns { flowId, authUrl } — the frontend should open authUrl in the browser.
 */
export function startOAuthFlow(providerId = "openai-codex") {
  const flowId = crypto.randomUUID();
  const { verifier, challenge } = createPkce();
  const state = crypto.randomUUID();
  const authUrl = buildAuthUrl({ state, challenge });

  const flow = {
    id: flowId,
    providerId,
    state,
    verifier,
    status: "pending", // pending → completed | error
    tokens: null,
    error: null,
    server: null,
    callbackUrl: CALLBACK_URL,
    manualRequired: false,
    callbackReady: false,
    timer: null,
  };

  activeFlows.set(flowId, flow);
  flow.timer = scheduleTimeout(flowId);

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleCallback(req, res, flow);
    });
    flow.server = server;

    let settled = false;
    const finish = (manualRequired) => {
      if (settled) return;
      settled = true;
      flow.manualRequired = manualRequired;
      resolve({
        flowId,
        authUrl,
        callbackUrl: CALLBACK_URL,
        manualRequired,
      });
    };

    server.once("error", (err) => {
      flow.callbackReady = false;
      flow.manualRequired = true;
      flow.error =
        err?.code === "EADDRINUSE"
          ? null
          : `Local callback server unavailable: ${err.message}`;
      finish(true);
    });

    server.listen(CALLBACK_PORT, () => {
      flow.callbackReady = true;
      finish(false);
    });
  });
}

/**
 * Get the status of an active flow.
 */
export function getFlowStatus(flowId) {
  const flow = activeFlows.get(flowId);
  if (!flow) return { status: "not_found" };
  return {
    status: flow.status,
    tokens: flow.tokens,
    error: flow.error,
    providerId: flow.providerId,
    callbackUrl: flow.callbackUrl,
    manualRequired: flow.manualRequired,
    callbackReady: flow.callbackReady,
  };
}

export async function submitOAuthRedirect(flowId, redirectUrl) {
  const flow = getFlow(flowId);
  const params = parseCodexRedirectUrl(redirectUrl);
  return completeOAuthFlow(flow, params);
}

function cleanupFlow(flowId) {
  const flow = activeFlows.get(flowId);
  if (!flow) return;
  if (flow.timer) clearTimeout(flow.timer);
  if (flow.server) {
    try {
      flow.server.close();
    } catch { /* ignore */ }
  }
  // Keep in map for 60s so frontend can poll the result
  setTimeout(() => activeFlows.delete(flowId), 60000);
}

async function handleCallback(req, res, flow) {
  const url = new URL(req.url, CALLBACK_URL);

  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const result = await completeOAuthFlow(flow, {
    code: url.searchParams.get("code") || "",
    state: url.searchParams.get("state") || "",
    error: url.searchParams.get("error") || "",
    errorDescription: url.searchParams.get("error_description") || "",
  });

  if (result.status === "completed") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(SUCCESS_HTML);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(ERROR_HTML(result.error || "Authentication failed"));
}
