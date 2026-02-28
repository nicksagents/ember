const DEFAULT_MAX_MEMORY_ITEMS = 10;
const DEFAULT_MAX_MEMORY_CHARS = 800;
const DEFAULT_CONTEXT_LIMIT = 40;
const DEFAULT_MAX_TOOL_ROUNDS = 20;
const DEFAULT_MEMORY_LIMIT = 5;
const DEFAULT_MAX_PINNED = 2;
const DEFAULT_MEMORY_MAX_AGE_DAYS = 180;
const DEFAULT_REFERENCE_MAX_AGE_DAYS = 45;
const DEFAULT_MIN_SCORE = 1;
const DEFAULT_EMBEDDING_DIM = 256;
const DEFAULT_MAX_MEMORY_BUCKET = 50;
const DEFAULT_RECENT_MEMORY_BUCKET = 50;
const DEFAULT_DECAY_HALF_LIFE_DAYS = 120;
const DEFAULT_USAGE_BOOST_MAX = 1.5;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 8000;
const DEFAULT_MAX_LIST_DIR_ENTRIES = 200;
const DEFAULT_MAX_TOOL_STREAM_CHARS = 4000;
const TOOL_LOOP_MESSAGE_LIMIT = 20;
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "are",
  "was",
  "were",
  "will",
  "can",
  "could",
  "should",
  "would",
  "have",
  "has",
  "had",
  "but",
  "not",
  "about",
  "into",
  "over",
  "under",
  "when",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "why",
  "than",
  "then",
  "them",
  "they",
  "their",
  "there",
  "here",
  "our",
  "ours",
  "its",
  "it's",
  "also",
  "use",
  "using",
  "used",
  "need",
  "needs",
  "want",
  "wants",
  "make",
  "making",
  "made",
]);

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const clampNumber = (value, min, max, fallback) => {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

export function validateChatRequest(body) {
  const errors = [];
  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["body must be an object"] };
  }

  const conversationId = isNonEmptyString(body.conversationId)
    ? body.conversationId.trim()
    : "";
  const content = isNonEmptyString(body.content) ? body.content.trim() : "";

  if (!conversationId) errors.push("conversationId is required");
  if (!content) errors.push("content is required");

  return errors.length
    ? { ok: false, errors }
    : { ok: true, data: { conversationId, content, config: body.config } };
}

export function sanitizeConfigInput(input) {
  if (!input || typeof input !== "object") return {};
  const safe = {};
  if (typeof input.provider === "string") safe.provider = input.provider;
  if (typeof input.endpoint === "string") safe.endpoint = input.endpoint;
  if (typeof input.model === "string") safe.model = input.model;
  if (typeof input.statelessProvider === "boolean") {
    safe.statelessProvider = input.statelessProvider;
  }
  if (typeof input.unrestrictedShell === "boolean") {
    safe.unrestrictedShell = input.unrestrictedShell;
  }
  if (typeof input.webSearchEnabled === "boolean") {
    safe.webSearchEnabled = input.webSearchEnabled;
  }
  if (typeof input.temperature === "number") {
    safe.temperature = clampNumber(input.temperature, 0, 2, 0.7);
  }
  if (typeof input.top_p === "number") {
    safe.top_p = clampNumber(input.top_p, 0, 1, 0.8);
  }
  if (typeof input.top_k === "number") {
    safe.top_k = clampNumber(input.top_k, 0, 100, 20);
  }
  if (typeof input.min_p === "number") {
    safe.min_p = clampNumber(input.min_p, 0, 1, 0);
  }
  if (typeof input.repetition_penalty === "number") {
    safe.repetition_penalty = clampNumber(input.repetition_penalty, 0.5, 2.0, 1.05);
  }
  if (typeof input.max_tokens === "number") {
    safe.max_tokens = clampNumber(input.max_tokens, 64, 8192, 2048);
  }
  if (typeof input.maxToolRounds === "number") {
    safe.maxToolRounds = clampNumber(input.maxToolRounds, 1, 50, 20);
  }
  if (typeof input.lightweightMode === "boolean") {
    safe.lightweightMode = input.lightweightMode;
  }
  if (typeof input.githubUsername === "string") {
    safe.githubUsername = input.githubUsername;
  }
  if (typeof input.githubEmail === "string") {
    safe.githubEmail = input.githubEmail;
  }
  if (typeof input.githubToken === "string") {
    safe.githubToken = input.githubToken;
  }
  if (typeof input.workspaceRoot === "string") {
    safe.workspaceRoot = input.workspaceRoot;
  }
  if (typeof input.desktopDir === "string") {
    safe.desktopDir = input.desktopDir;
  }
  if (input.modelRoles && typeof input.modelRoles === "object") {
    const roles = {};
    for (const key of ["assistant", "planner", "coder", "critic"]) {
      if (typeof input.modelRoles[key] === "string") {
        roles[key] = input.modelRoles[key];
      }
    }
    safe.modelRoles = roles;
  }
  if (typeof input.corePrompt === "string") safe.corePrompt = input.corePrompt;
  if (typeof input.userMd === "string") safe.userMd = input.userMd;
  if (typeof input.soulMd === "string") safe.soulMd = input.soulMd;
  return safe;
}

export function buildSystemPrompt({
  corePrompt,
  userMd,
  soulMd,
  skillsSummary,
  workspaceSummary,
  memories,
  maxMemoryItems = DEFAULT_MAX_MEMORY_ITEMS,
  maxMemoryChars = DEFAULT_MAX_MEMORY_CHARS,
}) {
  const sections = [];
  if (isNonEmptyString(corePrompt)) sections.push(corePrompt.trim());
  sections.push(
    [
      "[Workflow]",
      "For tool-backed tasks, always use 3 layers in order:",
      "1. Understand the task: identify the goal, constraints, target paths/services, and success criteria.",
      "2. Execute the task: use the minimum necessary tools and keep moving until the task is actually changed.",
      "3. Verify the result: use tools to confirm the requested end state before the final answer.",
      "Never claim success from intention, a PID, or an unverified command alone.",
    ].join("\n")
  );
  if (isNonEmptyString(workspaceSummary)) {
    sections.push(workspaceSummary.trim());
  }
  if (Array.isArray(memories) && memories.length > 0) {
    const items = [];
    let totalChars = 0;
    for (const mem of memories.slice(-maxMemoryItems)) {
      const content = typeof mem.content === "string" ? mem.content.trim() : "";
      if (!content) continue;
      if (totalChars + content.length > maxMemoryChars) break;
      items.push(`- ${content}`);
      totalChars += content.length;
    }
    if (items.length > 0) {
      sections.push(`[Memories]\n${items.join("\n")}`);
    }
  }

  if (isNonEmptyString(userMd)) sections.push(`[user.md]\n${userMd.trim()}`);
  if (isNonEmptyString(soulMd)) sections.push(`[soul.md]\n${soulMd.trim()}`);
  if (isNonEmptyString(skillsSummary)) sections.push(skillsSummary.trim());

  return sections.filter(Boolean).join("\n\n");
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export function parseLooseToolCalls(content) {
  if (typeof content !== "string") return [];
  const calls = [];
  let index = 0;
  const seen = new Set();
  const pushToolCall = (name, args) => {
    const safeName = String(name || "").trim();
    if (!safeName) return;
    const serializedArgs = JSON.stringify(args ?? {});
    const fingerprint = `${safeName}:${serializedArgs}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    calls.push({
      id: `tool_${Date.now()}_${index++}`,
      type: "function",
      function: {
        name: safeName,
        arguments: serializedArgs,
      },
    });
  };

  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let toolMatch;
  while ((toolMatch = toolCallRegex.exec(content))) {
    const raw = (toolMatch[1] || "").trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const name = parsed?.name || parsed?.function?.name;
      const args = parsed?.arguments ?? parsed?.function?.arguments ?? {};
      if (name) {
        pushToolCall(String(name), args ?? {});
      }
    } catch {
      // ignore invalid json tool_call blocks
    }
  }

  const functionRegex = /<function\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/function>/gi;
  let match;
  while ((match = functionRegex.exec(content))) {
    const name = match[1].trim();
    const body = match[2] || "";
    const args = {};
    const paramRegex = /<parameter\s*=\s*([^\s>]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let param;
    while ((param = paramRegex.exec(body))) {
      const key = param[1].trim();
      const raw = (param[2] || "").trim();
      let value = raw;
      if (raw === "true") value = true;
      else if (raw === "false") value = false;
      else if (raw && !Number.isNaN(Number(raw))) value = Number(raw);
      args[key] = value;
    }
    pushToolCall(name, args);
  }

  const bracketRegex = /^\s*\[([a-z_][a-z0-9_]*)\]\s*(.+?)\s*(?:\n|$)/gim;
  let bracketMatch;
  while ((bracketMatch = bracketRegex.exec(content))) {
    const name = (bracketMatch[1] || "").trim();
    const rawArgs = (bracketMatch[2] || "").trim();
    if (!name || !rawArgs) continue;

    let args = null;
    if (rawArgs.startsWith("{") && rawArgs.endsWith("}")) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = null;
      }
    }
    if (!args) {
      if (name === "web_search") {
        args = { query: rawArgs };
      } else if (name === "fetch_url") {
        args = { url: rawArgs };
      } else if (name === "list_dir" || name === "read_file" || name === "stat_path") {
        args = { path: rawArgs };
      } else if (name === "run_command") {
        args = { command: rawArgs };
      } else {
        args = { input: rawArgs };
      }
    }
    pushToolCall(name, args);
  }

  // Fallback: detect markdown bash/shell code blocks → run_command
  if (calls.length === 0) {
    const bashBlockRegex = /```(?:bash|shell|sh)\s*\n([\s\S]*?)```/gi;
    let bashMatch;
    while ((bashMatch = bashBlockRegex.exec(content))) {
      const block = (bashMatch[1] || "").trim();
      if (!block) continue;
      const firstLine = block.split("\n")[0].trim();
      // Skip if it looks like fabricated output (ls output, permissions, etc.)
      if (/^(?:total\s+\d|d?[r-][w-][x-]|lrwx|crw-|\d+\s)/.test(firstLine)) continue;
      if (firstLine.length < 2) continue;
      pushToolCall("run_command", { command: firstLine });
      break; // Only convert the first bash block
    }
  }

  // Fallback: detect narrative mentions of known tool names with extractable args
  if (calls.length === 0) {
    const KNOWN_FS_TOOLS = ["list_dir", "read_file", "stat_path"];
    const lower = content.toLowerCase();
    for (const toolName of KNOWN_FS_TOOLS) {
      if (!lower.includes(toolName)) continue;
      const pathMatch = content.match(/(?:\/[\w./-]+|~\/[\w./-]+|\.\/[\w./-]+)/);
      if (pathMatch) {
        pushToolCall(toolName, { path: pathMatch[0] });
        break;
      }
    }
    if (calls.length === 0 && lower.includes("run_command")) {
      const cmdMatch = content.match(/`([^`]{3,})`/);
      if (cmdMatch) {
        pushToolCall("run_command", { command: cmdMatch[1].trim() });
      }
    }
    if (calls.length === 0 && lower.includes("web_search")) {
      const queryMatch = content.match(
        /(?:search\s+(?:for\s+)?|query\s+)["']?([^"'\n]{5,})["']?/i
      );
      if (queryMatch) {
        pushToolCall("web_search", { query: queryMatch[1].trim() });
      }
    }
  }

  return calls;
}

function formatToolFallback(name, result) {
  if (!name || !result) return "";
  if (result.error) {
    return `Tool ${name} failed: ${result.error}`;
  }
  if (name === "list_dir" && Array.isArray(result.entries)) {
    const items = result.entries.map((e) => `- ${e.name}`).join("\n");
    return items ? `Here are the items:\n\n${items}` : "The directory is empty.";
  }
  if (name === "read_file" && typeof result.content === "string") {
    return result.content;
  }
  if (name === "stat_path") {
    return JSON.stringify(result, null, 2);
  }
  if (name === "run_command") {
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    return [stdout, stderr].filter(Boolean).join("\n");
  }
  return "";
}

export function looksLikeActionPreface(content) {
  const text = String(content || "").trim().toLowerCase();
  if (!text) return false;
  if ([
    /\blet me\b.*\b(?:check|look|inspect|explore|review|read|open|search|scan|go through|use|call|run)\b/,
    /\bi(?:'ll| will)\b.*\b(?:check|look|inspect|explore|review|read|open|search|scan|go through|use|call|run)\b/,
    /\bfirst[, ]+\bi(?:'ll| will)\b/,
    /\bi(?:'m| am)\s+going\s+to\b.*\b(?:check|look|inspect|explore|review|read|open|search|scan|use|call|run)\b/,
    /\btake a look\b/,
    /\bchecking\b.*\b(?:file|files|folder|directory|project|repo|repository|codebase|structure)\b/,
  ].some((pattern) => pattern.test(text))) return true;
  // Detect mentions of actual tool names in narrative text
  const TOOL_NAMES = [
    "list_dir", "read_file", "write_file", "stat_path", "run_command",
    "remove_path", "move_path", "copy_path", "web_search", "fetch_url",
    "list_processes", "kill_process", "start_dev_server", "verify_server",
  ];
  if (TOOL_NAMES.some((name) => text.includes(name))) return true;
  // Detect markdown bash blocks (model trying to act with wrong format)
  if (/```(?:bash|shell|sh)\s*\n/.test(text)) return true;
  return false;
}

function hashToken(token, dim) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % dim;
}

export function buildEmbedding(text, dim = DEFAULT_EMBEDDING_DIM) {
  const vector = Array(dim).fill(0);
  const tokens = tokenize(text || "");
  for (const token of tokens) {
    const idx = hashToken(token, dim);
    vector[idx] += 1;
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const bigram = `${tokens[i]}_${tokens[i + 1]}`;
    const idx = hashToken(bigram, dim);
    vector[idx] += 0.5;
  }
  return vector;
}

function cosineSimilarity(a, b) {
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

function scoreMemory(mem, tokens, fullQuery, queryEmbedding) {
  if (!mem || typeof mem.content !== "string") return 0;
  const content = mem.content.toLowerCase();
  let score = 0;

  if (fullQuery && content.includes(fullQuery)) {
    if (fullQuery.length / Math.max(content.length, 1) >= 0.6) {
      score += 3;
    }
  }
  for (const token of tokens) {
    if (content.includes(token)) score += 1;
  }

  if (Array.isArray(mem.tags)) {
    const tagString = mem.tags.join(" ").toLowerCase();
    for (const token of tokens) {
      if (tagString.includes(token)) score += 0.5;
    }
  }

  if (mem.type) {
    const type = String(mem.type).toLowerCase();
    if (type === "identity") score += 1;
    if (type === "preference") score += 0.7;
    if (type === "workflow") score += 0.5;
    if (type === "project") score += 0.5;
    if (type === "reference") score += 0.3;
  }

  if (mem.ts) {
    const ageMs = Date.now() - Date.parse(mem.ts);
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      const days = ageMs / 86_400_000;
      score += Math.max(0, 2 - Math.min(days / 30, 2));
    }
  }

  if (queryEmbedding) {
    const memEmbedding =
      Array.isArray(mem.embedding) && mem.embedding.length === queryEmbedding.length
        ? mem.embedding
        : buildEmbedding(mem.content);
    const sim = cosineSimilarity(queryEmbedding, memEmbedding);
    if (sim > 0) score += sim * 2;
  }

  if (typeof mem.useCount === "number") {
    const boost = Math.min(
      DEFAULT_USAGE_BOOST_MAX,
      Math.log1p(mem.useCount) / 2
    );
    score += boost;
  }

  if (mem.lastUsed) {
    const ageMs = Date.now() - Date.parse(mem.lastUsed);
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      const days = ageMs / 86_400_000;
      const decay = Math.exp(-Math.log(2) * days / DEFAULT_DECAY_HALF_LIFE_DAYS);
      score *= Math.max(0.5, decay);
    }
  }

  if (mem.confirmed === false) {
    score *= 0.8;
  }

  return score;
}

export function selectRelevantMemories(
  memories,
  query,
  limit = DEFAULT_MEMORY_LIMIT,
  options = {}
) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  const fullQuery = isNonEmptyString(query) ? query.toLowerCase().trim() : "";
  const tokens = tokenize(fullQuery);
  const queryEmbedding = fullQuery ? buildEmbedding(fullQuery) : null;
  const maxPinned =
    typeof options.maxPinned === "number" ? options.maxPinned : DEFAULT_MAX_PINNED;
  const maxAgeDays =
    typeof options.maxAgeDays === "number"
      ? options.maxAgeDays
      : DEFAULT_MEMORY_MAX_AGE_DAYS;
  const referenceMaxAgeDays =
    typeof options.referenceMaxAgeDays === "number"
      ? options.referenceMaxAgeDays
      : DEFAULT_REFERENCE_MAX_AGE_DAYS;
  const minScore =
    typeof options.minScore === "number" ? options.minScore : DEFAULT_MIN_SCORE;

  const now = Date.now();
  const isPinned = (mem) =>
    Array.isArray(mem?.tags) && mem.tags.some((tag) => tag === "pin");
  const isConfirmed = (mem) => mem?.confirmed !== false;
  const isInvalidated = (mem) => mem?.invalidatedAt != null;
  const isApproved = (mem) => mem?.approved !== false;

  const isFresh = (mem) => {
    if (!mem?.ts) return true;
    const ageMs = now - Date.parse(mem.ts);
    if (!Number.isFinite(ageMs)) return true;
    return ageMs <= maxAgeDays * 86_400_000;
  };

  const isReferenceFresh = (mem) => {
    if (!mem?.ts) return true;
    const ageMs = now - Date.parse(mem.ts);
    if (!Number.isFinite(ageMs)) return true;
    return ageMs <= referenceMaxAgeDays * 86_400_000;
  };

  const pool = memories.filter((mem) => {
    if (isPinned(mem)) return true;
    if (!isFresh(mem)) return false;
    if (mem?.type === "reference" && !isReferenceFresh(mem)) return false;
    return true;
  });

  const pinned = pool
    .filter(isPinned)
    .slice(-maxPinned);

  if (!fullQuery && tokens.length === 0) {
    return pinned.slice(0, limit);
  }

  const scored = pool
    .filter((mem) => !isPinned(mem))
    .map((mem, index) => ({
      mem,
      score: scoreMemory(mem, tokens, fullQuery, queryEmbedding),
      index,
    }))
    .filter((entry) => {
      if (isInvalidated(entry.mem)) return false;
      if (!isApproved(entry.mem)) return false;
      if (entry.score < minScore) return false;
      if (!isConfirmed(entry.mem) && entry.score < minScore + 0.5) return false;
      return true;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.index - a.index;
    })
    .map((entry) => entry.mem);

  const remaining = Math.max(0, limit - pinned.length);
  return pinned.concat(scored.slice(0, remaining)).slice(0, limit);
}

function memorySimilarity(a, b) {
  if (!a || !b) return 0;
  const aEmbedding = Array.isArray(a.embedding)
    ? a.embedding
    : buildEmbedding(a.content || "");
  const bEmbedding = Array.isArray(b.embedding)
    ? b.embedding
    : buildEmbedding(b.content || "");
  if (aEmbedding.length !== bEmbedding.length) {
    return cosineSimilarity(
      buildEmbedding(a.content || ""),
      buildEmbedding(b.content || "")
    );
  }
  return cosineSimilarity(aEmbedding, bEmbedding);
}

export function consolidateMemories(memories, similarityThreshold = 0.92) {
  if (!Array.isArray(memories) || memories.length < 2) {
    return { updated: memories || [], merged: [] };
  }

  const updated = memories.map((m) => ({ ...m }));
  const merged = [];
  const used = new Set();

  for (let i = 0; i < updated.length; i += 1) {
    if (used.has(updated[i].id)) continue;
    for (let j = i + 1; j < updated.length; j += 1) {
      if (used.has(updated[j].id)) continue;
      const sim = memorySimilarity(updated[i], updated[j]);
      if (sim < similarityThreshold) continue;

      let primary = updated[i];
      let secondary = updated[j];

      // Never merge non-cluster memories into a cluster summary.
      if (primary.type === "cluster" && secondary.type !== "cluster") {
        primary = updated[j];
        secondary = updated[i];
      }
      if (primary.type === "cluster" && secondary.type === "cluster") {
        continue;
      }

      primary.tags = Array.from(
        new Set([...(primary.tags || []), ...(secondary.tags || [])])
      );
      primary.confirmed = primary.confirmed && secondary.confirmed;
      primary.confidence = Math.max(primary.confidence || 0, secondary.confidence || 0);
      primary.useCount = Math.max(primary.useCount || 0, secondary.useCount || 0);
      primary.lastUsed =
        primary.lastUsed && secondary.lastUsed
          ? primary.lastUsed > secondary.lastUsed
            ? primary.lastUsed
            : secondary.lastUsed
          : primary.lastUsed || secondary.lastUsed || null;
      if (
        typeof primary.content === "string" &&
        typeof secondary.content === "string" &&
        secondary.content.length > primary.content.length
      ) {
        primary.content = secondary.content;
        primary.embedding = Array.isArray(secondary.embedding)
          ? secondary.embedding
          : buildEmbedding(secondary.content);
      }

      used.add(secondary.id);
      merged.push({ from: secondary.id, into: primary.id, similarity: sim });
    }
  }

  const filtered = updated.filter((m) => !used.has(m.id));
  return { updated: filtered, merged };
}

export function computeMemoryDomain(query, memories) {
  const tokens = tokenize(query || "");
  const scores = { identity: 0, preference: 0, workflow: 0, project: 0, reference: 0 };
  const typeByToken = {
    name: "identity",
    preference: "preference",
    like: "preference",
    love: "preference",
    hate: "preference",
    prefer: "preference",
    always: "workflow",
    never: "workflow",
    format: "workflow",
    respond: "workflow",
    project: "project",
    build: "project",
    plan: "project",
    roadmap: "project",
    docs: "reference",
    latest: "reference",
    version: "reference",
    price: "reference",
  };

  for (const token of tokens) {
    const mapped = typeByToken[token];
    if (mapped) scores[mapped] += 1;
  }

  if (Array.isArray(memories)) {
    for (const mem of memories) {
      const t = mem?.type;
      if (!t || !(t in scores)) continue;
      if (!mem?.content) continue;
      const contentTokens = tokenize(mem.content);
      for (const token of tokens) {
        if (contentTokens.includes(token)) scores[t] += 0.3;
      }
    }
  }

  let best = "reference";
  let bestScore = 0;
  for (const key of Object.keys(scores)) {
    if (scores[key] > bestScore) {
      bestScore = scores[key];
      best = key;
    }
  }

  return best;
}

export function selectMemoriesByDomain(memories, domain, limit = DEFAULT_MEMORY_LIMIT) {
  if (!Array.isArray(memories)) return [];
  const filtered = memories.filter((mem) => mem?.type === domain);
  return filtered.slice(-limit);
}

export function bucketMemories(memories) {
  if (!Array.isArray(memories)) return { recent: [], longTerm: [] };
  const recent = memories.slice(-DEFAULT_RECENT_MEMORY_BUCKET);
  const longTerm = memories.slice(
    Math.max(0, memories.length - DEFAULT_RECENT_MEMORY_BUCKET - DEFAULT_MAX_MEMORY_BUCKET),
    Math.max(0, memories.length - DEFAULT_RECENT_MEMORY_BUCKET)
  );
  return { recent, longTerm };
}

export function selectMemoriesWithFallback(memories, query, limit, options) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (memories.length < 30) {
    return selectRelevantMemories(memories, query, limit, options);
  }
  const domain = computeMemoryDomain(query, memories);
  const buckets = bucketMemories(memories);
  const domainMemories = [
    ...selectMemoriesByDomain(buckets.longTerm, domain, 10),
    ...selectMemoriesByDomain(buckets.recent, domain, 10),
  ];
  const primary = selectRelevantMemories(domainMemories, query, limit, options);
  if (primary.length > 0) return primary;

  const fallbackPool = [...buckets.longTerm, ...buckets.recent];
  return selectRelevantMemories(fallbackPool, query, limit, options);
}

function normalizeMemoryText(text) {
  return text.trim().replace(/\s+/g, " ");
}

function addCandidate(candidates, content, tags, reason) {
  const normalized = normalizeMemoryText(content);
  if (!normalized) return;
  if (normalized.length > 280) return;
  const entry = {
    content: normalized,
    tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
    reason: reason || "derived from user message",
    type: Array.isArray(tags) && tags[0] ? tags[0] : "preference",
    confidence: 0.9,
  };
  candidates.push(entry);
}

function alreadyKnown(content, existingMemories) {
  if (!Array.isArray(existingMemories)) return false;
  const normalized = normalizeMemoryText(content).toLowerCase();
  return existingMemories.some(
    (mem) =>
      typeof mem?.content === "string" &&
      normalizeMemoryText(mem.content).toLowerCase() === normalized
  );
}

export function detectMemoryCandidates(
  userText,
  existingMemories,
  limit = 3
) {
  if (typeof userText !== "string") return [];
  const text = userText.trim();
  if (!text) return [];

  const candidates = [];

  // Identity / name
  const nameMatch = text.match(
    /\b(?:my name is|call me)\s+([^,.\n]+)\b/i
  );
  if (nameMatch) {
    const value = nameMatch[1].trim();
    if (value.length > 1 && !/\d/.test(value)) {
      addCandidate(
        candidates,
        `User's name is ${value}.`,
        ["identity"],
        "user identity"
      );
    }
  }
  const nameMatchAlt = text.match(/\b(?:i am|i'm)\s+([A-Za-z][^,.\n]+)\b/i);
  if (nameMatchAlt) {
    const value = nameMatchAlt[1].trim();
    if (value.length > 1 && !/\d/.test(value)) {
      addCandidate(
        candidates,
        `User's name is ${value}.`,
        ["identity"],
        "user identity"
      );
    }
  }

  // Age
  const ageMatch = text.match(/\b(?:i am|i'm)\s+(\d{1,3})\b/i);
  if (ageMatch) {
    const age = Number.parseInt(ageMatch[1], 10);
    if (Number.isFinite(age) && age > 3 && age < 120) {
      addCandidate(
        candidates,
        `User is ${age} years old.`,
        ["identity"],
        "user age"
      );
    }
  }

  // Pets
  const petNamedMatch = text.match(
    /\b(?:i have|i've got|i got|my)\s+(?:a|an)?\s*(dog|cat|pet)\s+(?:named|called)\s+([^,.\n]+)\b/i
  );
  if (petNamedMatch) {
    const petType = petNamedMatch[1].toLowerCase();
    const petName = petNamedMatch[2].trim();
    if (petName.length > 1) {
      addCandidate(
        candidates,
        `User has a ${petType} named ${petName}.`,
        ["identity", "pet"],
        "user pet"
      );
    }
  }
  const petBreedMatch = text.match(
    /\b(?:my\s+)?(?:dog|cat|pet)\s+(?:is|is a|is an)\s+([^,.\n]+)\b/i
  );
  if (petBreedMatch) {
    const breed = petBreedMatch[1].trim();
    if (breed.length > 2) {
      addCandidate(
        candidates,
        `User's pet is a ${breed}.`,
        ["identity", "pet"],
        "pet breed"
      );
    }
  }
  const pronounBreedMatch = text.match(/\b(?:she|he|they)\s+(?:is|is a|is an)\s+([^,.\n]+)\b/i);
  if (pronounBreedMatch) {
    const breed = pronounBreedMatch[1].trim();
    if (/\b(shiba|dog|cat|puppy|kitten)\b/i.test(breed)) {
      addCandidate(
        candidates,
        `User's pet is a ${breed}.`,
        ["identity", "pet"],
        "pet breed"
      );
    }
  }
  const petSinceMatch = text.match(
    /\b(?:i'?ve|i have)\s+had\s+(?:him|her|them|it)\s+since\s+i\s+was\s+(\d{1,3})\b/i
  );
  if (petSinceMatch) {
    const sinceAge = Number.parseInt(petSinceMatch[1], 10);
    if (Number.isFinite(sinceAge) && sinceAge > 3 && sinceAge < 120) {
      addCandidate(
        candidates,
        `User has had their pet since age ${sinceAge}.`,
        ["identity", "pet"],
        "pet history"
      );
    }
  }

  // Preferences
  const prefMatch = text.match(
    /\b(?:i (?:really )?(?:like|love|prefer|enjoy)|i (?:don't|do not) like|i hate)\s+([^,.\n]+)\b/i
  );
  if (prefMatch) {
    const value = prefMatch[1].trim();
    if (value.length > 1) {
      addCandidate(
        candidates,
        `User prefers ${value}.`,
        ["preference"],
        "user preference"
      );
    }
  }

  // Workflow / instruction style
  const workflowMatch = text.match(
    /\b(?:please|always|never)\s+(?:use|do|format|respond|write|avoid)\s+([^,.\n]+)\b/i
  );
  if (workflowMatch) {
    const value = workflowMatch[1].trim();
    if (value.length > 1) {
      addCandidate(
        candidates,
        `User prefers you to ${value}.`,
        ["workflow"],
        "user workflow preference"
      );
    }
  }

  // Project / ongoing work
  const projectMatch = text.match(
    /\b(?:i'?m working on|we're building|we are building|project is|project)\s+([^,.\n]+)\b/i
  );
  if (projectMatch) {
    const value = projectMatch[1].trim();
    if (value.length > 1) {
      addCandidate(
        candidates,
        `User is working on ${value}.`,
        ["project"],
        "ongoing project"
      );
    }
  }

  // Progress / milestones
  const progressMatch = text.match(
    /\b(?:we (?:made|made good|finished|implemented|added|built|shipped|completed)|progress on|we now have|we've now|we have now)\s+([^,.\n]+)\b/i
  );
  if (progressMatch) {
    const value = progressMatch[1].trim();
    if (value.length > 1) {
      addCandidate(
        candidates,
        `Project progress: ${value}.`,
        ["project", "milestone"],
        "project milestone"
      );
    }
  }

  const filtered = candidates.filter(
    (entry) => !alreadyKnown(entry.content, existingMemories)
  );

  return filtered.slice(0, limit);
}

export function detectAssistantFacts(assistantText, existingMemories, limit = 2) {
  if (typeof assistantText !== "string") return [];
  const text = assistantText.trim();
  if (!text) return [];
  if (/\b(?:can't determine|cannot determine|not sure|unknown)\b/i.test(text)) {
    return [];
  }

  const candidates = [];
  const addAssistantCandidate = (content, tags) => {
    if (alreadyKnown(content, existingMemories)) return;
    addCandidate(candidates, content, tags, "derived from assistant output");
  };

  const osMatch = text.match(
    /\b(?:you(?:'re| are) running|your system is running|system:\s*)(Ubuntu|Debian|Fedora|Arch|macOS|Windows(?: Server)?|Alpine|CentOS|RHEL|Red Hat|Rocky|Amazon Linux)(?:\s*v?(\d+(?:\.\d+)*))?/i
  );
  if (osMatch) {
    const osName = osMatch[1];
    const osVersion = osMatch[2] ? ` ${osMatch[2]}` : "";
    addAssistantCandidate(
      `System is running ${osName}${osVersion}.`,
      ["reference", "system"]
    );
  }

  const nodeMatch = text.match(/\bNode\.js\s*v?(\d+(?:\.\d+)+)/i);
  if (nodeMatch) {
    addAssistantCandidate(
      `Node.js version is ${nodeMatch[1]}.`,
      ["reference", "system"]
    );
  }

  const pythonMatch = text.match(/\bPython\s+(\d+(?:\.\d+)+)/i);
  if (pythonMatch) {
    addAssistantCandidate(
      `Python version is ${pythonMatch[1]}.`,
      ["reference", "system"]
    );
  }

  const npmMatch = text.match(/\bnpm\s+v?(\d+(?:\.\d+)+)/i);
  if (npmMatch) {
    addAssistantCandidate(
      `npm version is ${npmMatch[1]}.`,
      ["reference", "system"]
    );
  }

  const gitMatch = text.match(/\bgit\s+version\s+(\d+(?:\.\d+)+)/i);
  if (gitMatch) {
    addAssistantCandidate(
      `git version is ${gitMatch[1]}.`,
      ["reference", "system"]
    );
  }

  return candidates.slice(0, limit);
}

export function detectMemoryInvalidations(userText, existingMemories) {
  if (typeof userText !== "string" || !Array.isArray(existingMemories)) return [];
  const text = userText.toLowerCase();
  const invalidated = [];

  for (const mem of existingMemories) {
    if (!mem?.id || typeof mem.content !== "string") continue;
    const content = mem.content.toLowerCase();

    // Preference negation: "I don't like X" vs "User prefers X"
    const prefMatch = content.match(/user prefers (.+)\./);
    if (prefMatch) {
      const value = prefMatch[1].trim();
      if (value && text.includes(`don't like ${value}`)) {
        invalidated.push(mem.id);
      }
      if (value && text.includes(`do not like ${value}`)) {
        invalidated.push(mem.id);
      }
      if (value && text.includes(`hate ${value}`)) {
        invalidated.push(mem.id);
      }
    }

    // Workflow negation: "don't do X" vs "User prefers you to X"
    const workflowMatch = content.match(/user prefers you to (.+)\./);
    if (workflowMatch) {
      const value = workflowMatch[1].trim();
      if (value && text.includes(`don't ${value}`)) {
        invalidated.push(mem.id);
      }
      if (value && text.includes(`do not ${value}`)) {
        invalidated.push(mem.id);
      }
      if (value && text.includes(`never ${value}`)) {
        invalidated.push(mem.id);
      }
    }
  }

  return Array.from(new Set(invalidated));
}

export function buildContextMessages(history, userContent, limit = DEFAULT_CONTEXT_LIMIT) {
  const contextMessages = Array.isArray(history)
    ? history.slice(-limit).map((m) => ({
        role: m.role,
        content: m.content,
      }))
    : [];
  contextMessages.push({ role: "user", content: userContent });
  return contextMessages;
}

function looksLikeWriteCommand(command) {
  const token = String(command || "").toLowerCase();
  return (
    token.includes(" rm ") ||
    token.includes(" rm\t") ||
    token.includes(" mv ") ||
    token.includes(" mv\t") ||
    token.includes(" cp ") ||
    token.includes(" cp\t") ||
    token.includes(" mkdir ") ||
    token.includes(" rmdir ") ||
    token.includes(" touch ") ||
    token.includes(" >") ||
    token.includes(">>") ||
    token.includes(" sed -i") ||
    token.includes(" perl -i") ||
    token.includes(" truncate ")
  );
}

function looksLikeGitCommand(command) {
  const token = String(command || "").toLowerCase();
  return token.includes("git ");
}

function looksLikeServerStartCommand(command) {
  const token = ` ${String(command || "").toLowerCase()} `;
  return (
    token.includes(" npm run dev ") ||
    token.includes(" npm run start ") ||
    token.includes(" pnpm dev ") ||
    token.includes(" pnpm start ") ||
    token.includes(" yarn dev ") ||
    token.includes(" yarn start ") ||
    token.includes(" bun run dev ") ||
    token.includes(" next dev ") ||
    token.includes(" vite ") ||
    token.includes(" webpack-dev-server ") ||
    token.includes(" python -m http.server ") ||
    token.includes(" uvicorn ") ||
    token.includes(" docker compose up ") ||
    token.includes(" docker-compose up ")
  );
}

function toolResultHasErrorValue(parsed) {
  return Boolean(
    parsed?.error ||
      parsed?.ok === false ||
      parsed?.timedOut === true ||
      parsed?.started === false ||
      (parsed?.exitCode !== undefined && parsed.exitCode !== 0)
  );
}

function toolResultHasErrorContent(content) {
  try {
    const parsed = JSON.parse(content);
    return toolResultHasErrorValue(parsed);
  } catch {
    return false;
  }
}

function truncateText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function formatToolResultContent(toolName, result) {
  const safeResult =
    result && typeof result === "object" && !Array.isArray(result)
      ? { ...result }
      : { result };

  if (toolName === "list_dir" && Array.isArray(safeResult.entries)) {
    const total = safeResult.entries.length;
    if (total > DEFAULT_MAX_LIST_DIR_ENTRIES) {
      safeResult.entries = safeResult.entries.slice(0, DEFAULT_MAX_LIST_DIR_ENTRIES);
      safeResult.truncated = true;
      safeResult.totalEntries = total;
      safeResult.note = `Showing first ${DEFAULT_MAX_LIST_DIR_ENTRIES} entries.`;
    }
  }

  if (toolName === "run_command") {
    if (typeof safeResult.stdout === "string" && safeResult.stdout.length > DEFAULT_MAX_TOOL_STREAM_CHARS) {
      safeResult.stdout = truncateText(safeResult.stdout, DEFAULT_MAX_TOOL_STREAM_CHARS);
      safeResult.stdoutTruncated = true;
    }
    if (typeof safeResult.stderr === "string" && safeResult.stderr.length > DEFAULT_MAX_TOOL_STREAM_CHARS) {
      safeResult.stderr = truncateText(safeResult.stderr, DEFAULT_MAX_TOOL_STREAM_CHARS);
      safeResult.stderrTruncated = true;
    }
  }

  const json = JSON.stringify(safeResult);
  if (json.length <= DEFAULT_MAX_TOOL_RESULT_CHARS) return json;
  return JSON.stringify({
    truncated: true,
    note: "Tool result truncated to fit context window.",
    preview: json.slice(0, DEFAULT_MAX_TOOL_RESULT_CHARS),
  });
}

function trimToolLoopPayload(messages, maxToolRoundMessages = TOOL_LOOP_MESSAGE_LIMIT) {
  let toolStartIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role === "tool" || (msg.role === "assistant" && msg.tool_calls)) {
      toolStartIndex = i;
    } else if (msg.role === "user" && !msg.content?.startsWith("[System note]")) {
      toolStartIndex = i + 1;
      break;
    }
  }

  if (toolStartIndex < 0 || toolStartIndex >= messages.length) return messages;

  const prefix = messages.slice(0, toolStartIndex);
  const toolMessages = messages.slice(toolStartIndex);

  if (toolMessages.length <= maxToolRoundMessages) return messages;

  const trimmed = toolMessages.slice(-maxToolRoundMessages);
  const droppedCount = toolMessages.length - maxToolRoundMessages;
  const summaryNote = {
    role: "user",
    content: `[System note] ${droppedCount} earlier tool messages trimmed. Continue with the current task.`,
  };

  return [...prefix, summaryNote, ...trimmed];
}

export async function runToolLoop({
  payload,
  callLLM,
  executeTool,
  maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS,
  toolSkillLoader,
  preToolSkillInjection = true,
  verifyToolResults = true,
  requireToolCall = false,
  fallbackToolCall,
  directToolOutput = false,
  completionGuard = null,
  buildVerifyPrompt = null,
  toolCallGuard = null,
  onAssistantMessage = null,
}) {
  let llmResponse = await callLLM(payload);
  let assistantContent = "";
  const injectedSkills = new Set();
  let lastToolError = null;
  let toolUsed = false;
  let lastToolName = null;
  let lastToolResult = null;
  let needsVerify = false;
  let awaitingVerificationResult = false;
  let lastRoundHadErrors = false;

  for (let round = 0; round < maxToolRounds; round++) {
    const choice = llmResponse?.choices?.[0];
    const message = choice?.message;
    if (
      typeof onAssistantMessage === "function" &&
      requireToolCall &&
      typeof message?.content === "string" &&
      message.content.trim()
    ) {
      await onAssistantMessage(message.content, {
        round,
        hasToolCalls: Boolean(message?.tool_calls?.length),
        looksLikeActionPreface: looksLikeActionPreface(message.content),
      });
    }
    if (!message && requireToolCall && typeof fallbackToolCall === "function") {
      const fallback = await fallbackToolCall(null, payload, { phase: "execute" });
      if (fallback?.name) {
        const toolCall = {
          id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: "function",
          function: {
            name: fallback.name,
            arguments: JSON.stringify(fallback.arguments || {}),
          },
        };
        const toolResults = [];
        const result = await executeTool(toolCall.function.name, fallback.arguments || {}, toolCall);
        if (result && result.error && !lastToolError) lastToolError = result.error;
        if (
          toolCall.function.name === "run_command" &&
          looksLikeServerStartCommand(fallback.arguments?.command)
        ) {
          needsVerify = true;
        }
        toolUsed = true;
        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: formatToolResultContent(toolCall.function.name, result),
        });
        if (directToolOutput) {
          const forced = formatToolFallback(lastToolName, lastToolResult);
          if (forced) {
            return { assistantContent: forced, finalResponse: llmResponse };
          }
        }
        payload.messages.push({
          role: "assistant",
          tool_calls: [toolCall],
        });
        payload.messages.push(...toolResults);
        if (verifyToolResults) {
          const fallbackHasErrors = toolResults.some((tr) =>
            toolResultHasErrorContent(tr.content)
          );
          if (!fallbackHasErrors && awaitingVerificationResult) {
            awaitingVerificationResult = false;
          }
          lastRoundHadErrors = fallbackHasErrors;
          let verifyContent = fallbackHasErrors
            ? "[System note] Tool error. Retry with corrected arguments or explain the error."
            : "[System note] Call the next tool. Only respond when ALL steps are complete and verified.";
          if (!fallbackHasErrors && needsVerify) {
            verifyContent =
              "[System note] Verify the change with a tool before responding.";
            needsVerify = false;
            awaitingVerificationResult = true;
          }
          if (typeof buildVerifyPrompt === "function") {
            const customVerifyContent = buildVerifyPrompt({
              hasErrors: fallbackHasErrors,
              toolCalls: [toolCall],
              toolResults,
              defaultPrompt: verifyContent,
              phase: "fallback",
            });
            if (typeof customVerifyContent === "string" && customVerifyContent.trim()) {
              verifyContent = customVerifyContent;
            }
          }
          payload.messages.push({
            role: "user",
            content: verifyContent,
          });
        }
        payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
        llmResponse = await callLLM(payload);
        continue;
      }
    }

    if ((!message?.tool_calls || message.tool_calls.length === 0) && message?.content) {
      const parsed = parseLooseToolCalls(message.content);
      if (parsed.length > 0) {
        message.tool_calls = parsed;
        message.content = null;
      }
    }

    let hasToolCalls = Boolean(message?.tool_calls && message.tool_calls.length > 0);

    if (!hasToolCalls) {
      const prefaceFallback =
        typeof fallbackToolCall === "function" && looksLikeActionPreface(message?.content)
          ? await fallbackToolCall(message, payload, { phase: "execute", reason: "preface" })
          : null;
      if (prefaceFallback?.name) {
        message.tool_calls = [
          {
            id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: "function",
            function: {
              name: prefaceFallback.name,
              arguments: JSON.stringify(prefaceFallback.arguments || {}),
            },
          },
        ];
        message.content = null;
        hasToolCalls = true;
      }
    }

    if (!hasToolCalls) {
      if (typeof completionGuard === "function") {
        const guard = await completionGuard({
          payload,
          message,
          round,
          toolUsed,
          lastToolError,
        });
        if (guard && guard.block === true && typeof fallbackToolCall === "function" && guard.phase) {
          const fallback = await fallbackToolCall(message, payload, { phase: guard.phase });
          if (fallback?.name) {
            message.tool_calls = [
              {
                id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: "function",
                function: {
                  name: fallback.name,
                  arguments: JSON.stringify(fallback.arguments || {}),
                },
              },
            ];
            message.content = null;
            hasToolCalls = true;
          }
        }
      }
      if (hasToolCalls) {
        // A completion guard injected a required verification tool call.
      } else
      if (verifyToolResults && awaitingVerificationResult) {
        if (typeof fallbackToolCall === "function") {
          const fallback = await fallbackToolCall(message, payload, { phase: "verify" });
          if (fallback?.name) {
            message.tool_calls = [
              {
                id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: "function",
                function: {
                  name: fallback.name,
                  arguments: JSON.stringify(fallback.arguments || {}),
                },
              },
            ];
            message.content = null;
          }
        }
      }
      hasToolCalls = Boolean(message?.tool_calls && message.tool_calls.length > 0);
      if (verifyToolResults && awaitingVerificationResult && !hasToolCalls) {
        payload.messages.push(message || { role: "assistant", content: "" });
        payload.messages.push({
          role: "user",
          content:
            "[System note] Verification is still required. Call a tool now to verify before final response.",
        });
        payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
        llmResponse = await callLLM(payload);
        continue;
      }
      if (verifyToolResults && lastRoundHadErrors) {
        const text = String(message?.content || "").toLowerCase();
        const acknowledgesError =
          text.includes("error") ||
          text.includes("failed") ||
          text.includes("unable") ||
          text.includes("cannot") ||
          text.includes("couldn't") ||
          text.includes("timed out") ||
          text.includes("permission");
        if (!acknowledgesError) {
          payload.messages.push(message || { role: "assistant", content: "" });
          payload.messages.push({
            role: "user",
            content:
              "[System note] The last tool failed. Do not claim success. Retry with corrected arguments or clearly explain the failure.",
          });
          payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
          llmResponse = await callLLM(payload);
          continue;
        }
      }
      if (!hasToolCalls && requireToolCall && !toolUsed) {
        if (typeof fallbackToolCall === "function") {
          const fallback = await fallbackToolCall(message, payload, { phase: "execute" });
          if (fallback?.name) {
            const toolCall = {
              id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: "function",
              function: {
                name: fallback.name,
                arguments: JSON.stringify(fallback.arguments || {}),
              },
            };
            if (directToolOutput) {
              const result = await executeTool(
                toolCall.function.name,
                fallback.arguments || {},
                toolCall
              );
              lastToolName = toolCall.function.name;
              lastToolResult = result;
              toolUsed = true;
              const forced = formatToolFallback(lastToolName, lastToolResult);
              if (forced) {
                return { assistantContent: forced, finalResponse: llmResponse };
              }
            } else {
              message.tool_calls = [toolCall];
              message.content = null;
            }
          } else {
            payload.messages.push(message);
            payload.messages.push({
              role: "user",
              content:
                "[System note] Use a tool to answer this request. Call a tool now.",
            });
            payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
            llmResponse = await callLLM(payload);
            continue;
          }
        } else {
          payload.messages.push(message);
          payload.messages.push({
            role: "user",
            content:
              "[System note] You must call a tool. Do not answer directly.",
          });
          payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
          llmResponse = await callLLM(payload);
          continue;
        }
      }
      hasToolCalls = Boolean(message?.tool_calls && message.tool_calls.length > 0);
      if (!hasToolCalls) {
        if (typeof completionGuard === "function") {
          const guard = await completionGuard({
            payload,
            message,
            round,
            toolUsed,
            lastToolError,
          });
          if (guard && guard.block === true) {
            payload.messages.push(message || { role: "assistant", content: "" });
            payload.messages.push({
              role: "user",
              content:
                guard.note ||
                "[System note] The task is not complete yet. Continue with tools until the result is verified.",
            });
            payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
            llmResponse = await callLLM(payload);
            continue;
          }
        }
        assistantContent =
          message?.content ||
          llmResponse?.message?.content ||
          llmResponse?.response ||
          "No response content";
        return { assistantContent, finalResponse: llmResponse };
      }
    }

    if (typeof toolCallGuard === "function") {
      const guard = await toolCallGuard({
        payload,
        message,
        round,
        toolUsed,
        lastToolError,
      });
      if (guard && guard.block === true) {
        payload.messages.push({
          role: "user",
          content:
            guard.note ||
            "[System note] Do not call that tool again. Answer with the information already gathered.",
        });
        payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
        llmResponse = await callLLM(payload);
        continue;
      }
    }

    if (preToolSkillInjection && typeof toolSkillLoader === "function") {
      const pendingSkillBlocks = [];
      for (const toolCall of message.tool_calls) {
        const name = toolCall?.function?.name;
        if (!name || injectedSkills.has(name)) continue;
        const skill = await toolSkillLoader(name);
        if (skill) {
          pendingSkillBlocks.push(`[Tool skill: ${name}]\n${skill}`);
        }
        injectedSkills.add(name);
      }
      if (pendingSkillBlocks.length > 0) {
        payload.messages.push(message);
        payload.messages.push({
          role: "user",
          content: `[System note] ${pendingSkillBlocks.join("\n\n")}`,
        });
        payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
        llmResponse = await callLLM(payload);
        continue;
      }
    }

    const toolResults = [];
    for (const toolCall of message.tool_calls) {
      let args = {};
      try {
        args =
          typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments || {};
      } catch {
        args = {};
      }
      const result = await executeTool(toolCall.function.name, args, toolCall);
      if (result && result.error && !lastToolError) {
        lastToolError = result.error;
      }
      const toolName = toolCall.function.name;
      if (
        toolName === "write_file" ||
        toolName === "remove_path" ||
        toolName === "move_path" ||
        toolName === "copy_path" ||
        toolName === "kill_process" ||
        toolName === "start_dev_server"
      ) {
        needsVerify = true;
      } else if (toolName === "run_command") {
        if (
          looksLikeWriteCommand(args?.command) ||
          looksLikeGitCommand(args?.command) ||
          looksLikeServerStartCommand(args?.command)
        ) {
          needsVerify = true;
        }
      } else if (toolName === "github_repo") {
        needsVerify = true;
      }
      toolUsed = true;
      lastToolName = toolName;
      lastToolResult = result;
      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: formatToolResultContent(toolName, result),
      });
    }

    payload.messages.push(message);
    payload.messages.push(...toolResults);

    if (directToolOutput) {
      const forced = formatToolFallback(lastToolName, lastToolResult);
      if (forced) {
        return { assistantContent: forced, finalResponse: llmResponse };
      }
    }

    if (typeof toolSkillLoader === "function") {
      const skillBlocks = [];
      for (const toolCall of message.tool_calls) {
        const name = toolCall?.function?.name;
        if (!name || injectedSkills.has(name)) continue;
        const skill = await toolSkillLoader(name);
        if (skill) {
          skillBlocks.push(`[Tool skill: ${name}]\n${skill}`);
        }
        injectedSkills.add(name);
      }
      if (skillBlocks.length > 0) {
        payload.messages.push({
          role: "user",
          content: `[System note] ${skillBlocks.join("\n\n")}`,
        });
      }
    }

    if (verifyToolResults) {
      // Check if any tool results contain errors
      const hasErrors = toolResults.some((tr) =>
        toolResultHasErrorContent(tr.content)
      );
      if (!hasErrors && awaitingVerificationResult) {
        awaitingVerificationResult = false;
      }
      lastRoundHadErrors = hasErrors;
      let verifyContent = hasErrors
        ? "[System note] Tool error. Retry with corrected arguments or explain the error."
        : "[System note] Call the next tool. Only respond when ALL steps are complete and verified.";
      if (!hasErrors && needsVerify) {
        verifyContent =
          "[System note] Verify the change with a tool before responding.";
        needsVerify = false;
        awaitingVerificationResult = true;
      }
      if (typeof buildVerifyPrompt === "function") {
        const customVerifyContent = buildVerifyPrompt({
          hasErrors,
          toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
          toolResults,
          defaultPrompt: verifyContent,
          phase: "normal",
        });
        if (typeof customVerifyContent === "string" && customVerifyContent.trim()) {
          verifyContent = customVerifyContent;
        }
      }
      payload.messages.push({
        role: "user",
        content: verifyContent,
      });
    }
    payload.messages = trimToolLoopPayload(payload.messages, TOOL_LOOP_MESSAGE_LIMIT);
    llmResponse = await callLLM(payload);
  }

  const fallback = llmResponse?.choices?.[0]?.message;
  assistantContent =
    fallback?.content || llmResponse?.response || "No response content";
  if (requireToolCall && lastToolError) {
    if (!assistantContent || assistantContent === "No response content") {
      assistantContent = `I couldn't complete that because the tool failed: ${lastToolError}`;
    }
  }
  if (!assistantContent || assistantContent === "No response content") {
    if (lastToolResult && lastToolName) {
      const forced = formatToolFallback(lastToolName, lastToolResult);
      if (forced) assistantContent = forced;
    }
  }
  if (typeof completionGuard === "function") {
    const guard = await completionGuard({
      payload,
      message: fallback,
      round: maxToolRounds,
      toolUsed,
      lastToolError,
    });
    if (guard && guard.block === true) {
      assistantContent =
        guard.note ||
        "I could not verify that the task completed successfully before the tool loop ended.";
    }
  }
  return { assistantContent, finalResponse: llmResponse };
}
