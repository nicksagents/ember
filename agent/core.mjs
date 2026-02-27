const DEFAULT_MAX_MEMORY_ITEMS = 20;
const DEFAULT_MAX_MEMORY_CHARS = 4000;
const DEFAULT_CONTEXT_LIMIT = 40;
const DEFAULT_MAX_TOOL_ROUNDS = 20;
const DEFAULT_MEMORY_LIMIT = 2;
const DEFAULT_MAX_PINNED = 1;
const DEFAULT_MEMORY_MAX_AGE_DAYS = 180;
const DEFAULT_REFERENCE_MAX_AGE_DAYS = 45;
const DEFAULT_MIN_SCORE = 1;
const DEFAULT_EMBEDDING_DIM = 64;
const DEFAULT_MAX_MEMORY_BUCKET = 50;
const DEFAULT_RECENT_MEMORY_BUCKET = 50;
const DEFAULT_DECAY_HALF_LIFE_DAYS = 120;
const DEFAULT_USAGE_BOOST_MAX = 1.5;
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
  memorySuggestions,
  maxMemoryItems = DEFAULT_MAX_MEMORY_ITEMS,
  maxMemoryChars = DEFAULT_MAX_MEMORY_CHARS,
}) {
  const sections = [];
  if (isNonEmptyString(corePrompt)) sections.push(corePrompt.trim());
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

  if (Array.isArray(memorySuggestions) && memorySuggestions.length > 0) {
    const items = memorySuggestions
      .map((sugg) => {
        const content =
          typeof sugg?.content === "string" ? sugg.content.trim() : "";
        if (!content) return "";
        const reason =
          typeof sugg?.reason === "string" ? sugg.reason.trim() : "";
        const type =
          typeof sugg?.type === "string" ? sugg.type.trim() : "";
        const confidence =
          typeof sugg?.confidence === "number"
            ? `, conf ${sugg.confidence.toFixed(2)}`
            : "";
        const meta = [type ? `type ${type}` : "", confidence ? `confidence${confidence}` : ""]
          .filter(Boolean)
          .join(", ");
        const suffix = [reason, meta].filter(Boolean).join("; ");
        return suffix ? `- ${content} (${suffix})` : `- ${content}`;
      })
      .filter(Boolean);
    if (items.length > 0) {
      sections.push(
        [
          "[Memory suggestions]",
          "If accurate and durable, consider saving with save_memory:",
          ...items,
        ].join("\n")
      );
    }
  }

  return sections.filter(Boolean).join("\n\n");
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function parseLooseToolCalls(content) {
  if (typeof content !== "string") return [];
  const calls = [];
  let index = 0;

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
        calls.push({
          id: `tool_${Date.now()}_${index++}`,
          type: "function",
          function: {
            name: String(name),
            arguments: JSON.stringify(args ?? {}),
          },
        });
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
    calls.push({
      id: `tool_${Date.now()}_${index++}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
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

function scoreMemory(mem, tokens, fullQuery) {
  if (!mem || typeof mem.content !== "string") return 0;
  const content = mem.content.toLowerCase();
  let score = 0;

  if (fullQuery && content.includes(fullQuery)) score += 3;
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

  if (fullQuery) {
    const queryEmbedding = buildEmbedding(fullQuery);
    const memEmbedding = Array.isArray(mem.embedding)
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
    score *= 0.6;
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
      score: scoreMemory(mem, tokens, fullQuery),
      index,
    }))
    .filter((entry) => {
      if (isInvalidated(entry.mem)) return false;
      if (!isApproved(entry.mem)) return false;
      if (entry.score < minScore) return false;
      if (!isConfirmed(entry.mem) && entry.score < minScore + 1) return false;
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
  if (normalized.length > 140) return;
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
    /\b(?:my name is|call me|i am|i'm)\s+([^,.\n]+)\b/i
  );
  if (nameMatch) {
    const value = nameMatch[1].trim();
    if (value.length > 1) {
      addCandidate(
        candidates,
        `User's name is ${value}.`,
        ["identity"],
        "user identity"
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
}) {
  let llmResponse = await callLLM(payload);
  let assistantContent = "";
  const injectedSkills = new Set();
  let lastToolError = null;
  let toolUsed = false;
  let lastToolName = null;
  let lastToolResult = null;
  let needsVerify = false;

  for (let round = 0; round < maxToolRounds; round++) {
    const choice = llmResponse?.choices?.[0];
    const message = choice?.message;
    if (!message && requireToolCall && typeof fallbackToolCall === "function") {
      const fallback = await fallbackToolCall(null, payload);
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
        toolUsed = true;
        toolResults.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
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
          const fallbackHasErrors = toolResults.some((tr) => {
            try {
              const parsed = JSON.parse(tr.content);
              return parsed?.error || parsed?.exitCode !== undefined && parsed.exitCode !== 0;
            } catch { return false; }
          });
          payload.messages.push({
            role: "user",
            content: fallbackHasErrors
              ? "[System note] One or more tools returned an error. Read the tool results carefully. Do NOT claim success if the tool failed. Explain what went wrong. Retry with corrected arguments if possible."
              : "[System note] Check the tool results. If incomplete, call tools again. If complete, answer the user directly.",
          });
        }
        llmResponse = await callLLM(payload);
        continue;
      }
    }

    if ((!message?.tool_calls || message.tool_calls.length === 0) && message?.content) {
      const parsed = parseLooseToolCalls(message.content);
      if (parsed.length > 0) {
        message.tool_calls = parsed;
        // Preserve text before the first tool call tag instead of discarding it
        const textBefore = message.content
          .replace(/<tool_call>[\s\S]*$/gi, "")
          .replace(/<function\s*=[\s\S]*$/gi, "")
          .trim();
        message.content = textBefore || null;
      }
    }

    if (!message?.tool_calls || message.tool_calls.length === 0) {
      if (requireToolCall && !toolUsed) {
        if (typeof fallbackToolCall === "function") {
          const fallback = await fallbackToolCall(message, payload);
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
            llmResponse = await callLLM(payload);
            continue;
          }
        } else {
          payload.messages.push(message);
          payload.messages.push({
            role: "system",
            content:
              "You must call a tool to answer this request. Do not answer directly. Emit only a tool call.",
          });
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
        toolName === "copy_path"
      ) {
        needsVerify = true;
      } else if (toolName === "run_command") {
        if (looksLikeWriteCommand(args?.command) || looksLikeGitCommand(args?.command)) {
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
        content: JSON.stringify(result),
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
      const hasErrors = toolResults.some((tr) => {
        try {
          const parsed = JSON.parse(tr.content);
          return parsed?.error || (parsed?.exitCode !== undefined && parsed.exitCode !== 0);
        } catch { return false; }
      });
      let verifyContent = hasErrors
        ? "[System note] One or more tools returned an error. Read the tool results carefully. Do NOT claim success if the tool failed. Explain what went wrong. Retry with corrected arguments if possible."
        : "[System note] Check the tool results. If incomplete, call tools again. If complete, answer the user directly.";
      if (!hasErrors && needsVerify) {
        verifyContent =
          "[System note] Verification required. Use a tool to verify the change before responding (stat_path/list_dir/read_file or git/github_repo verify).";
        needsVerify = false;
      }
      payload.messages.push({
        role: "user",
        content: verifyContent,
      });
    }
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
  return { assistantContent, finalResponse: llmResponse };
}
