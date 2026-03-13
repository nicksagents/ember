function safeLower(value) {
  return String(value || "").toLowerCase();
}

const COMPAT_PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const COMPAT_CACHE_KEY_RE = /^([^:]+)::(.+)$/;
const COMPAT_CACHE_MAX_KEYS = 256;
const COMPAT_CACHE_MAX_PARAMS_PER_KEY = 24;

function normalizeCompatParamName(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || !COMPAT_PARAM_NAME_RE.test(text)) return "";
  return text;
}

function normalizeCompatParams(params) {
  const unique = [];
  for (const raw of Array.isArray(params) ? params : []) {
    const normalized = normalizeCompatParamName(raw);
    if (!normalized || unique.includes(normalized)) continue;
    unique.push(normalized);
    if (unique.length >= COMPAT_CACHE_MAX_PARAMS_PER_KEY) break;
  }
  return unique;
}

export function buildPayloadCompatKey(providerId, model = "*") {
  const provider = String(providerId || "").trim().toLowerCase();
  const modelText = String(model || "*").trim().toLowerCase() || "*";
  if (!provider) return "";
  return `${provider}::${modelText}`;
}

export function normalizePayloadCompatCache(cache) {
  const source = cache && typeof cache === "object" ? cache : {};
  const next = {};
  for (const [rawKey, rawParams] of Object.entries(source)) {
    const keyText = String(rawKey || "").trim().toLowerCase();
    if (!keyText) continue;
    const match = keyText.match(COMPAT_CACHE_KEY_RE);
    if (!match) continue;
    const normalizedKey = buildPayloadCompatKey(match[1], match[2]);
    if (!normalizedKey || normalizedKey in next) continue;
    const params = normalizeCompatParams(rawParams);
    if (params.length === 0) continue;
    next[normalizedKey] = params;
    if (Object.keys(next).length >= COMPAT_CACHE_MAX_KEYS) break;
  }
  return next;
}

export function getCachedUnsupportedPayloadParams(cache, { providerId, model } = {}) {
  const normalized = normalizePayloadCompatCache(cache);
  const providerKey = buildPayloadCompatKey(providerId, "*");
  const modelKey = buildPayloadCompatKey(providerId, model || "*");
  if (!providerKey) return [];
  const combined = new Set([
    ...(Array.isArray(normalized[providerKey]) ? normalized[providerKey] : []),
    ...(Array.isArray(normalized[modelKey]) ? normalized[modelKey] : []),
  ]);
  return Array.from(combined);
}

export function mergeUnsupportedPayloadParams(
  cache,
  { providerId, model, unsupportedParams, includeProviderFallback = true } = {}
) {
  const normalizedCache = normalizePayloadCompatCache(cache);
  const toAdd = normalizeCompatParams(unsupportedParams);
  const modelKey = buildPayloadCompatKey(providerId, model || "*");
  if (!modelKey || toAdd.length === 0) {
    return {
      cache: normalizedCache,
      disabledParams: getCachedUnsupportedPayloadParams(normalizedCache, {
        providerId,
        model,
      }),
      changed: false,
    };
  }

  const targetKeys = [modelKey];
  const providerKey = buildPayloadCompatKey(providerId, "*");
  if (includeProviderFallback && providerKey && providerKey !== modelKey) {
    targetKeys.unshift(providerKey);
  }

  let changed = false;
  const next = { ...normalizedCache };
  for (const key of targetKeys) {
    const current = Array.isArray(next[key]) ? next[key] : [];
    const merged = Array.from(new Set([...current, ...toAdd])).slice(
      0,
      COMPAT_CACHE_MAX_PARAMS_PER_KEY
    );
    if (merged.length !== current.length) {
      changed = true;
      next[key] = merged;
    }
  }

  return {
    cache: next,
    disabledParams: getCachedUnsupportedPayloadParams(next, {
      providerId,
      model,
    }),
    changed,
  };
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
    const looksLikeCompletions = path.endsWith("/v1/chat/completions");
    return localHost && looksLikeCompletions;
  } catch {
    return false;
  }
}

export function shouldUsePromptOnlyTools({ endpoint, modelName, toolMode } = {}) {
  if (toolMode === "xml") return true;
  if (toolMode === "native") return false;

  if (toolMode === "auto" || !toolMode) {
    if (isLikelyLlamaCppEndpoint(endpoint)) return true;
  }

  return false;
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
