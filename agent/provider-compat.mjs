function safeLower(value) {
  return String(value || "").toLowerCase();
}

export function isLikelyLlamaCppEndpoint(endpoint) {
  const text = String(endpoint || "").trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    const host = safeLower(url.hostname);
    const path = safeLower(url.pathname);
    const localHost =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    const defaultApiPath = path.endsWith("/v1/chat/completions");
    const defaultPort = url.port === "8080" || url.port === "";
    return localHost && defaultApiPath && defaultPort;
  } catch {
    return false;
  }
}

export function shouldUsePromptOnlyTools({ endpoint, modelName }) {
  return isLikelyLlamaCppEndpoint(endpoint) &&
    safeLower(modelName).includes("qwen") &&
    safeLower(modelName).includes("coder");
}

export function extractUnsupportedPayloadParams(errorText) {
  const text = String(errorText || "");
  const found = new Set();
  const patterns = [
    /unsupported param(?:eter)?\s*[:=]\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi,
    /unknown field\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/gi,
    /unrecognized field\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/gi,
    /invalid field\s*["']([a-zA-Z_][a-zA-Z0-9_]*)["']/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      if (match[1]) found.add(match[1]);
    }
  }
  return Array.from(found);
}

export function stripUnsupportedPayloadParams(payload, unsupportedParams = []) {
  const blocked = new Set(
    Array.isArray(unsupportedParams) ? unsupportedParams.filter(Boolean) : []
  );
  if (blocked.size === 0) return payload;

  const nextPayload = { ...(payload || {}) };
  for (const key of blocked) {
    delete nextPayload[key];
    if (key === "tools") {
      delete nextPayload.tool_choice;
    }
  }
  return nextPayload;
}
