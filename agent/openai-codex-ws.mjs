import WebSocket from "ws";

const DEFAULT_CODEX_WS_URL = "wss://api.openai.com/v1/responses";
const SESSION_IDLE_TTL_MS = 20 * 60 * 1000;

const sessions = new Map();

function nowMs() {
  return Date.now();
}

function sumCounts(counts, endExclusive) {
  let total = 0;
  for (let i = 0; i < endExclusive; i += 1) {
    total += Number(counts?.[i] || 0);
  }
  return total;
}

export function buildCodexWsRequest(params) {
  const previousResponseId = params?.previousResponseId || "";
  const lastMessageCount = Number(params?.lastMessageCount || 0);
  const messageCount = Number(params?.messageCount || 0);
  const messageItemCounts = Array.isArray(params?.messageItemCounts)
    ? params.messageItemCounts
    : [];
  const input = Array.isArray(params?.input) ? params.input : [];

  if (!previousResponseId || lastMessageCount <= 0 || messageCount < lastMessageCount) {
    return {
      input,
      previousResponseId: "",
      incremental: false,
    };
  }

  const offset = sumCounts(messageItemCounts, lastMessageCount);
  const incrementalInput = input.slice(offset);
  if (incrementalInput.length === 0) {
    return {
      input,
      previousResponseId: "",
      incremental: false,
    };
  }

  return {
    input: incrementalInput,
    previousResponseId,
    incremental: true,
  };
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

export function buildCodexWsPayload(params) {
  const payload = {
    model: params?.model,
    store: false,
    ...(params?.instructions ? { instructions: params.instructions } : {}),
    input: params?.input,
    ...(params?.previousResponseId
      ? { previous_response_id: params.previousResponseId }
      : {}),
    ...(Array.isArray(params?.tools) && params.tools.length > 0 ? { tools: params.tools } : {}),
    ...(params?.toolChoice ? { tool_choice: params.toolChoice } : {}),
    ...(params?.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params?.topP !== undefined ? { top_p: params.topP } : {}),
    ...(params?.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
    ...(params?.reasoning ? { reasoning: params.reasoning } : {}),
    truncation: "auto",
  };
  return applyDisabledPayloadParams(payload, params?.disabledParams);
}

function cleanupExpiredSessions() {
  const now = nowMs();
  for (const [key, session] of sessions.entries()) {
    if (now - session.lastUsedAt <= SESSION_IDLE_TTL_MS) continue;
    session.close();
    sessions.delete(key);
  }
}

function normalizeWsUrl(provider) {
  const explicit = String(provider?.websocketEndpoint || "").trim();
  if (explicit) return explicit;
  return DEFAULT_CODEX_WS_URL;
}

class CodexWebSocketSession {
  constructor({ apiKey, wsUrl }) {
    this.apiKey = apiKey;
    this.wsUrl = wsUrl;
    this.socket = null;
    this.connectPromise = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.previousResponseId = "";
    this.lastMessageCount = 0;
    this.lastUsedAt = nowMs();
  }

  touch() {
    this.lastUsedAt = nowMs();
  }

  close() {
    if (this.pending?.reject) {
      this.pending.reject(new Error("Codex WebSocket session closed"));
      this.pending = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
    }
    this.socket = null;
    this.connectPromise = null;
  }

  async connect() {
    this.touch();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "responses-websocket=v1",
        },
      });

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };

      const onOpen = () => {
        cleanup();
        this.socket = socket;
        this._bindSocketEvents(socket);
        resolve();
      };

      const onError = (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  _bindSocketEvents(socket) {
    socket.on("message", (chunk) => {
      this.touch();
      this._handleMessage(chunk);
    });
    socket.on("close", () => {
      if (this.pending?.reject) {
        this.pending.reject(new Error("Codex WebSocket connection closed"));
        this.pending = null;
      }
      this.socket = null;
    });
    socket.on("error", (error) => {
      if (this.pending?.reject) {
        this.pending.reject(error instanceof Error ? error : new Error(String(error)));
        this.pending = null;
      }
      this.socket = null;
    });
  }

  _handleMessage(chunk) {
    if (!this.pending) return;
    let parsed;
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.type === "response.completed" && parsed.response) {
      const pending = this.pending;
      this.pending = null;
      this.previousResponseId = String(parsed.response.id || this.previousResponseId || "");
      pending.resolve(parsed.response);
      return;
    }

    if (parsed.type === "response.failed") {
      const message =
        parsed?.response?.error?.message ||
        parsed?.response?.status ||
        "Codex response failed";
      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error(String(message)));
      return;
    }

    if (parsed.type === "error") {
      const pending = this.pending;
      this.pending = null;
      pending.reject(new Error(String(parsed.message || parsed.code || "Codex WebSocket error")));
    }
  }

  async request(payload, { timeoutMs = 120000, messageCount = 0 } = {}) {
    const run = async () => {
      await this.connect();
      this.touch();
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex WebSocket is not connected");
      }
      if (this.pending) {
        throw new Error("Codex WebSocket session already has an active request");
      }

      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending?.reject === reject) {
            this.pending = null;
          }
          reject(new Error(`Codex WebSocket timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        this.pending = {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };

        this.socket.send(
          JSON.stringify({
            type: "response.create",
            ...payload,
          })
        );
      });

      this.lastMessageCount = messageCount;
      return response;
    };

    const queued = this.queue.catch(() => {}).then(run);
    this.queue = queued.catch(() => {});
    return queued;
  }
}

function getSession(sessionId, provider, apiKey) {
  cleanupExpiredSessions();
  const key = `${sessionId}::${provider?.id || "openai-codex"}`;
  const wsUrl = normalizeWsUrl(provider);
  const current = sessions.get(key);
  if (current && current.apiKey === apiKey && current.wsUrl === wsUrl) {
    current.touch();
    return current;
  }
  if (current) {
    current.close();
    sessions.delete(key);
  }
  const session = new CodexWebSocketSession({ apiKey, wsUrl });
  sessions.set(key, session);
  return session;
}

export async function requestCodexWebSocket(params) {
  const apiKey = String(params?.apiKey || "").trim();
  const sessionId = String(params?.sessionId || "").trim();
  if (!apiKey) throw new Error("Codex WebSocket requires an access token");
  if (!sessionId) throw new Error("Codex WebSocket requires a session id");

  const session = getSession(sessionId, params?.provider, apiKey);
  const requestShape = buildCodexWsRequest({
    previousResponseId: session.previousResponseId,
    lastMessageCount: session.lastMessageCount,
    messageCount: params?.messageCount,
    messageItemCounts: params?.messageItemCounts,
    input: params?.input,
  });

  const payload = buildCodexWsPayload({
    ...params,
    input: requestShape.input,
    previousResponseId: requestShape.previousResponseId,
  });

  return session.request(payload, {
    timeoutMs: params?.timeoutMs,
    messageCount: Number(params?.messageCount || 0),
  });
}
