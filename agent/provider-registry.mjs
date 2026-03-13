import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { resolveProviderApiKey } from "./auth-sources.mjs";
import { requestCodexWebSocket } from "./openai-codex-ws.mjs";

/* ── Model runtime profiles ──────────────────────────────────────────────
 * Maps model-id prefixes to optimal runtime settings.
 * getModelRuntimeProfile() matches the longest prefix first.
 */
const MODEL_RUNTIME_PROFILES = {
  // Anthropic
  "claude-opus":   { temperature: 0.3, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 200000 },
  "claude-sonnet": { temperature: 0.4, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 200000 },
  "claude-haiku":  { temperature: 0.3, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 200000 },
  // OpenAI Codex
  "gpt-5.3-codex": { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5.2-codex": { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5.1-codex": { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 272000 },
  "gpt-5-mini":    { temperature: 0.4, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 272000 },
  // OpenAI reasoning
  "o3":            { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 200000 },
  "o4-mini":       { temperature: 1.0, top_p: 1.0, max_tokens: 16384, toolMode: "native", contextWindow: 200000 },
  // OpenAI GPT
  "gpt-4.1":      { temperature: 0.2, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 1000000 },
  "gpt-4o":       { temperature: 0.3, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "gpt-4.5":      { temperature: 0.3, top_p: 0.9, max_tokens: 8192,  toolMode: "native", contextWindow: 128000 },
  // DeepSeek
  "deepseek-chat":     { temperature: 0.5, top_p: 0.9, max_tokens: 4096,  toolMode: "native", contextWindow: 128000 },
  "deepseek-reasoner": { temperature: 0.0, top_p: 1.0, max_tokens: 8192,  toolMode: "native", contextWindow: 128000 },
  // Gemini
  "gemini-3":  { temperature: 0.4, top_p: 0.9, max_tokens: 4096, toolMode: "native", contextWindow: 1000000 },
  "gemini-2":  { temperature: 0.4, top_p: 0.9, max_tokens: 4096, toolMode: "native", contextWindow: 1000000 },
  // Moonshot / Kimi
  "moonshot":  { temperature: 0.5, top_p: 0.9, max_tokens: 4096, toolMode: "native", contextWindow: 128000 },
  "kimi":      { temperature: 0.5, top_p: 0.9, max_tokens: 4096, toolMode: "native", contextWindow: 128000 },
  // Local Qwen
  "qwen":      { temperature: 0.7, top_p: 0.8, max_tokens: 2048, toolMode: "xml",    contextWindow: 28660 },
};

// Sorted by key length descending so longer prefixes match first
const _sortedProfileKeys = Object.keys(MODEL_RUNTIME_PROFILES)
  .sort((a, b) => b.length - a.length);

export function getModelRuntimeProfile(modelId) {
  const id = String(modelId || "").toLowerCase();
  for (const prefix of _sortedProfileKeys) {
    if (id.startsWith(prefix) || id.includes(prefix)) {
      return { ...MODEL_RUNTIME_PROFILES[prefix], matchedPrefix: prefix };
    }
  }
  return null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deriveModelsUrl(provider) {
  const explicit = String(provider?.modelsEndpoint || "").trim();
  if (explicit) return explicit;

  const endpoint = String(provider?.endpoint || "").trim();
  if (!endpoint) return "";

  try {
    const url = new URL(endpoint);
    if (provider?.type === "anthropic") {
      url.pathname = "/v1/models";
      return url.toString();
    }
    url.pathname = url.pathname
      .replace(/\/v1\/chat\/completions$/, "/v1/models")
      .replace(/\/v1\/responses$/, "/v1/models");
    if (!/\/v1\/models$/.test(url.pathname)) {
      url.pathname = "/v1/models";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function getCodexModelsCachePath() {
  const override = String(process.env.EMBER_CODEX_MODELS_CACHE_PATH || "").trim();
  if (override) return override;
  return path.join(os.homedir(), ".codex", "models_cache.json");
}

function normalizeProviderId(providerId) {
  const id = String(providerId || "").trim().toLowerCase();
  if (!id) return "";
  if (id === "codex") return "openai-codex";
  return id;
}

async function readCodexModelsCache() {
  try {
    const raw = await readFile(getCodexModelsCachePath(), "utf8");
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed?.models) ? parsed.models : [];
    const discovered = source
      .map((item) => String(item?.slug || item?.id || item?.name || "").trim())
      .filter(Boolean);
    const unique = Array.from(new Set(discovered));
    if (unique.includes("gpt-5.3-codex") && !unique.includes("gpt-5.3-codex-spark")) {
      unique.push("gpt-5.3-codex-spark");
    }
    return unique;
  } catch {
    return [];
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyDisabledPayloadParams(payload, disabledParams = []) {
  const blocked = new Set(
    Array.isArray(disabledParams) ? disabledParams.filter(Boolean) : []
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

function normalizeToolResultContent(content) {
  if (typeof content === "string") return content;
  if (isObject(content) || Array.isArray(content)) {
    return JSON.stringify(content);
  }
  return String(content ?? "");
}

function getTextContentFromAnthropicBlocks(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

function convertToolsToAnthropic(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const fn = tool?.function || tool || {};
    return {
      name: fn.name || "",
      description: fn.description || "",
      input_schema: fn.parameters || {
        type: "object",
        properties: {},
      },
    };
  });
}

function convertAnthropicResponse(result) {
  const contentBlocks = Array.isArray(result?.content) ? result.content : [];
  const text = getTextContentFromAnthropicBlocks(contentBlocks);
  const toolCalls = contentBlocks
    .filter((block) => block?.type === "tool_use" && block?.name)
    .map((block) => ({
      id: block.id || `tool_${Date.now()}`,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
      },
    }));

  return {
    id: result?.id || null,
    model: result?.model || "",
    usage: result?.usage || {},
    choices: [
      {
        index: 0,
        finish_reason:
          result?.stop_reason === "end_turn"
            ? "stop"
            : result?.stop_reason || "stop",
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function convertMessagesToOpenAIResponses(messages) {
  const instructions = [];
  const input = [];
  const messageItemCounts = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    let itemCount = 0;

    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.trim()) {
        instructions.push(message.content.trim());
      }
      messageItemCounts.push(0);
      continue;
    }

    if (message.role === "user") {
      const content = String(message.content || "").trim();
      if (content) {
        input.push({
          type: "message",
          role: "user",
          content,
        });
        itemCount += 1;
      }
      messageItemCounts.push(itemCount);
      continue;
    }

    if (message.role === "assistant") {
      const text = String(message.content || "").trim();
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: text,
        });
        itemCount += 1;
      }
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const rawArgs = toolCall?.function?.arguments;
        const serializedArgs =
          typeof rawArgs === "string"
            ? rawArgs
            : JSON.stringify(rawArgs || {});
        input.push({
          type: "function_call",
          call_id: toolCall?.id || `call_${Date.now()}`,
          name: toolCall?.function?.name || "",
          arguments: serializedArgs,
        });
        itemCount += 1;
      }
      messageItemCounts.push(itemCount);
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id || `call_${Date.now()}`,
        output: normalizeToolResultContent(message.content),
      });
      itemCount += 1;
    }
    messageItemCounts.push(itemCount);
  }

  return {
    instructions: instructions.join("\n\n").trim(),
    input,
    messageItemCounts,
  };
}

function convertToolsToOpenAIResponses(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const fn = tool?.function || tool || {};
    return {
      type: "function",
      name: fn.name || "",
      description: fn.description || "",
      parameters: fn.parameters || {
        type: "object",
        properties: {},
      },
    };
  });
}

function convertOpenAIResponsesResult(result) {
  const outputItems = Array.isArray(result?.output) ? result.output : [];
  const textParts = [];
  const toolCalls = [];

  for (const item of outputItems) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === "output_text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      continue;
    }
    if (item?.type === "function_call" && item?.name) {
      toolCalls.push({
        id: item.call_id || item.id || `tool_${Date.now()}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || {}),
        },
      });
    }
  }

  return {
    id: result?.id || null,
    model: result?.model || "",
    usage: {
      input_tokens: result?.usage?.input_tokens || 0,
      output_tokens: result?.usage?.output_tokens || 0,
      total_tokens: result?.usage?.total_tokens || 0,
    },
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: textParts.join("\n").trim() || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  };
}

function convertMessagesToAnthropic(messages) {
  const systemParts = [];
  const converted = [];
  let pendingToolResults = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) return;
    converted.push({
      role: "user",
      content: pendingToolResults,
    });
    pendingToolResults = [];
  };

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;

    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.trim()) {
        systemParts.push(message.content.trim());
      }
      continue;
    }

    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: normalizeToolResultContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      flushPendingToolResults();
      const blocks = [];
      if (typeof message.content === "string" && message.content.trim()) {
        blocks.push({ type: "text", text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          const rawArgs = toolCall?.function?.arguments;
          let parsedArgs = {};
          try {
            parsedArgs =
              typeof rawArgs === "string" && rawArgs.trim()
                ? JSON.parse(rawArgs)
                : rawArgs || {};
          } catch {
            parsedArgs = {};
          }
          blocks.push({
            type: "tool_use",
            id: toolCall?.id || `tool_${Date.now()}`,
            name: toolCall?.function?.name || "",
            input: parsedArgs,
          });
        }
      }
      converted.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    const userBlocks = [];
    if (pendingToolResults.length > 0) {
      userBlocks.push(...pendingToolResults);
      pendingToolResults = [];
    }
    if (typeof message.content === "string" && message.content.trim()) {
      userBlocks.push({ type: "text", text: message.content });
    }
    if (userBlocks.length > 0) {
      converted.push({
        role: "user",
        content: userBlocks,
      });
    }
  }

  flushPendingToolResults();

  return {
    system: systemParts.join("\n\n").trim(),
    messages: converted,
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider error ${response.status}: ${text}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function parseSseResponse(response) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    throw new Error("Provider returned an unreadable SSE response");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastCompletedResponse = null;

  const flushChunk = async (done = false) => {
    const separator = /\r?\n\r?\n/;
    while (separator.test(buffer)) {
      const match = buffer.match(separator);
      if (!match || match.index == null) break;
      const boundary = match.index + match[0].length;
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary);
      const lines = rawEvent.split(/\r?\n/);
      const dataLines = [];
      let eventName = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      const rawData = dataLines.join("\n").trim();
      if (!rawData || rawData === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        continue;
      }
      const eventType =
        String(parsed?.type || eventName || "").trim().toLowerCase();
      if (eventType === "response.failed") {
        const detail =
          parsed?.response?.error?.message ||
          parsed?.error?.message ||
          parsed?.detail ||
          rawData;
        throw new Error(`Provider SSE error: ${detail}`);
      }
      if (eventType === "response.completed" && parsed?.response) {
        lastCompletedResponse = parsed.response;
      }
    }
    if (done && buffer.trim()) {
      const leftover = buffer;
      buffer = "";
      const dataLines = leftover
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      const rawData = dataLines.join("\n").trim();
      if (rawData && rawData !== "[DONE]") {
        try {
          const parsed = JSON.parse(rawData);
          if (String(parsed?.type || "").trim().toLowerCase() === "response.completed") {
            lastCompletedResponse = parsed.response || lastCompletedResponse;
          }
        } catch {}
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        await flushChunk(true);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      await flushChunk(false);
    }
  } finally {
    reader.releaseLock();
  }

  if (!lastCompletedResponse) {
    throw new Error("Provider SSE ended without a completed response");
  }
  return lastCompletedResponse;
}

function looksLikeSsePayload(text) {
  const source = String(text || "").trim();
  if (!source) return false;
  const head = source.slice(0, 160).toLowerCase();
  return (
    head.startsWith("event:") ||
    head.startsWith("data:") ||
    head.includes("\nevent:") ||
    head.includes("\ndata:")
  );
}

function parseSseText(rawText) {
  const source = String(rawText || "");
  const chunks = source.split(/\r?\n\r?\n/);
  let lastCompletedResponse = null;

  for (const chunk of chunks) {
    if (!chunk || !chunk.trim()) continue;
    const lines = chunk.split(/\r?\n/);
    const dataLines = [];
    let eventName = "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    const rawData = dataLines.join("\n").trim();
    if (!rawData || rawData === "[DONE]") continue;

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      continue;
    }
    const eventType =
      String(parsed?.type || eventName || "").trim().toLowerCase();
    if (eventType === "response.failed") {
      const detail =
        parsed?.response?.error?.message ||
        parsed?.error?.message ||
        parsed?.detail ||
        rawData;
      throw new Error(`Provider SSE error: ${detail}`);
    }
    if (eventType === "response.completed" && parsed?.response) {
      lastCompletedResponse = parsed.response;
    }
  }

  if (!lastCompletedResponse) {
    throw new Error("Provider SSE ended without a completed response");
  }
  return lastCompletedResponse;
}

async function fetchJsonOrSseWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider error ${response.status}: ${text}`);
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (typeof response.text !== "function") {
      if (contentType.includes("text/event-stream")) {
        return await parseSseResponse(response);
      }
      return await response.json();
    }
    const rawText = await response.text();
    if (contentType.includes("text/event-stream") || looksLikeSsePayload(rawText)) {
      return parseSseText(rawText);
    }
    if (!rawText.trim()) {
      return {};
    }
    try {
      return JSON.parse(rawText);
    } catch (error) {
      const detail = rawText.slice(0, 500);
      throw new Error(
        `Provider returned invalid JSON: ${detail || (error instanceof Error ? error.message : "unknown parse error")}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAICompatible(provider, model, payload, options = {}) {
  const apiKey = await resolveProviderApiKey(provider);
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(isObject(provider?.headers) ? provider.headers : {}),
  };
  const body = {
    ...(payload || {}),
    model: model || provider.defaultModel,
  };
  const sanitizedBody = applyDisabledPayloadParams(body, options.disabledParams);
  return fetchJsonWithTimeout(provider.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(sanitizedBody),
  }, options.timeout || 120000);
}

async function callAnthropic(provider, model, payload, options = {}) {
  const apiKey = await resolveProviderApiKey(provider);
  const { system, messages } = convertMessagesToAnthropic(payload?.messages || []);
  const useBearer = provider?.authType === "claude-code-oauth";
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey
      ? useBearer
        ? { Authorization: `Bearer ${apiKey}` }
        : { "x-api-key": apiKey }
      : {}),
    "anthropic-version": "2023-06-01",
    ...(isObject(provider?.headers) ? provider.headers : {}),
  };
  const body = applyDisabledPayloadParams({
    model: model || provider.defaultModel,
    messages,
    max_tokens:
      payload?.max_tokens ||
      provider?.samplingDefaults?.max_tokens ||
      4096,
    temperature:
      payload?.temperature ?? provider?.samplingDefaults?.temperature ?? 0.3,
    top_p: payload?.top_p ?? provider?.samplingDefaults?.top_p ?? 0.9,
    ...(system ? { system } : {}),
    ...(Array.isArray(payload?.tools) && payload.tools.length > 0
      ? { tools: convertToolsToAnthropic(payload.tools) }
      : {}),
  }, options.disabledParams);
  const result = await fetchJsonWithTimeout(provider.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, options.timeout || 120000);
  return convertAnthropicResponse(result);
}

async function callOpenAICodex(provider, model, payload, options = {}) {
  const apiKey = await resolveProviderApiKey(provider);
  const { instructions, input, messageItemCounts } = convertMessagesToOpenAIResponses(
    payload?.messages || []
  );
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(isObject(provider?.headers) ? provider.headers : {}),
  };
  const toolChoice =
    payload?.tool_choice
      ? payload.tool_choice
      : Array.isArray(payload?.tools) && payload.tools.length > 0
        ? "auto"
        : undefined;
  const reasoning =
    String(model || provider.defaultModel || "").startsWith("gpt-5")
      ? { effort: "medium", summary: "auto" }
      : undefined;
  const body = applyDisabledPayloadParams({
    model: model || provider.defaultModel,
    store: false,
    stream: true,
    input,
    truncation: "auto",
    ...(instructions ? { instructions } : {}),
    ...(Array.isArray(payload?.tools) && payload.tools.length > 0
      ? { tools: convertToolsToOpenAIResponses(payload.tools) }
      : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(payload?.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload?.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload?.max_tokens ? { max_output_tokens: payload.max_tokens } : {}),
    ...(reasoning ? { reasoning } : {}),
  }, options.disabledParams);
  if (options?.sessionId) {
    try {
      const wsResult = await requestCodexWebSocket({
        apiKey,
        provider,
        sessionId: options.sessionId,
        model: model || provider.defaultModel,
        instructions,
        input,
        messageItemCounts,
        messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
        tools: Array.isArray(payload?.tools)
          ? convertToolsToOpenAIResponses(payload.tools)
          : [],
        toolChoice,
        temperature: payload?.temperature,
        topP: payload?.top_p,
        maxOutputTokens: payload?.max_tokens,
        reasoning,
        disabledParams: options.disabledParams,
        timeoutMs: options.timeout || 120000,
      });
      return convertOpenAIResponsesResult(wsResult);
    } catch (error) {
      if (options.transport === "websocket") {
        throw error;
      }
    }
  }
  const result = await fetchJsonOrSseWithTimeout(
    provider.endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    options.timeout || 120000
  );
  return convertOpenAIResponsesResult(result);
}

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
    this.adapters = new Map();
    this._registerBuiltinAdapters();
  }

  _registerBuiltinAdapters() {
    this.adapters.set("openai-compatible", callOpenAICompatible);
    this.adapters.set("openai-codex", callOpenAICodex);
    this.adapters.set("anthropic", callAnthropic);
    this.adapters.set("custom", callOpenAICompatible);
  }

  loadProviders(providerConfigs = []) {
    this.providers.clear();
    for (const provider of Array.isArray(providerConfigs) ? providerConfigs : []) {
      if (!provider?.id) continue;
      const normalizedId = normalizeProviderId(provider.id);
      this.providers.set(normalizedId, {
        ...cloneJson(provider),
        id: normalizedId,
      });
    }
  }

  getProvider(providerId) {
    if (!providerId) return null;
    return this.providers.get(normalizeProviderId(providerId)) || null;
  }

  listProviders({ includeDisabled = true } = {}) {
    const providers = Array.from(this.providers.values());
    return includeDisabled
      ? providers
      : providers.filter((provider) => provider.enabled !== false);
  }

  async callLLM(providerId, model, payload, options = {}) {
    const provider = this.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" is not configured`);
    }
    if (provider.enabled === false) {
      throw new Error(`Provider "${providerId}" is disabled`);
    }
    const adapter = this.adapters.get(provider.type || "openai-compatible");
    if (!adapter) {
      throw new Error(`Unsupported provider type "${provider.type}"`);
    }
    // Auto-apply runtime profile defaults when payload doesn't specify them
    const resolvedModel = model || provider.defaultModel;
    const profile = getModelRuntimeProfile(resolvedModel);
    if (profile && payload) {
      if (payload.temperature === undefined && payload.temperature !== 0) {
        payload.temperature = profile.temperature;
      }
      if (payload.top_p === undefined) {
        payload.top_p = profile.top_p;
      }
      if (!payload.max_tokens) {
        payload.max_tokens = profile.max_tokens;
      }
    }
    return adapter(provider, resolvedModel, payload, options);
  }

  async listModels(providerId) {
    const provider = this.getProvider(normalizeProviderId(providerId));
    if (!provider) {
      throw new Error(`Provider "${providerId}" is not configured`);
    }

    const fallbackModels = Array.isArray(provider.models)
      ? provider.models
      : [];
    if (
      normalizeProviderId(provider.id) === "openai-codex" ||
      String(provider.authType || "") === "codex-oauth"
    ) {
      const cachedModels = await readCodexModelsCache();
      return cachedModels.length > 0 ? cachedModels : fallbackModels;
    }
    const modelsUrl = deriveModelsUrl(provider);
    if (!modelsUrl || provider.type === "anthropic") {
      return fallbackModels;
    }

    try {
      const apiKey = await resolveProviderApiKey(provider);
      const headers = {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(isObject(provider?.headers) ? provider.headers : {}),
      };
      const result = await fetchJsonWithTimeout(modelsUrl, {
        method: "GET",
        headers,
      }, 30000);
      const rawList = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result?.models)
          ? result.models
          : Array.isArray(result)
            ? result
            : [];
      const discovered = rawList
        .map((item) => item?.id || item?.name || item?.model || "")
        .filter(Boolean);
      return discovered.length > 0 ? discovered : fallbackModels;
    } catch {
      return fallbackModels;
    }
  }
}
