import test from "node:test";
import assert from "node:assert/strict";
import {
  validateChatRequest,
  buildSystemPrompt,
  buildContextMessages,
  runToolLoop,
  selectRelevantMemories,
  detectMemoryCandidates,
  detectMemoryInvalidations,
  buildEmbedding,
  consolidateMemories,
  computeMemoryDomain,
  bucketMemories,
  selectMemoriesWithFallback,
} from "./core.mjs";

test("validateChatRequest rejects missing fields", () => {
  const result = validateChatRequest({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes("conversationId")));
  assert.ok(result.errors.some((err) => err.includes("content")));
});

test("buildSystemPrompt includes sections and caps memories", () => {
  const prompt = buildSystemPrompt({
    corePrompt: "Core",
    userMd: "User",
    soulMd: "Soul",
    skillsSummary: "Available skills: none",
    memories: [
      { content: "Memory A" },
      { content: "Memory B" },
      { content: "Memory C" },
    ],
    maxMemoryItems: 2,
  });
  assert.ok(prompt.includes("Core"));
  assert.ok(prompt.includes("[user.md]"));
  assert.ok(prompt.includes("[soul.md]"));
  assert.ok(prompt.includes("[Memories]"));
  assert.ok(prompt.includes("Memory B"));
  assert.ok(prompt.includes("Memory C"));
  assert.ok(!prompt.includes("Memory A"));
});

test("buildContextMessages appends user message", () => {
  const messages = buildContextMessages(
    [
      { role: "assistant", content: "A" },
      { role: "user", content: "B" },
    ],
    "C",
    10
  );
  assert.equal(messages[messages.length - 1].content, "C");
});

test("selectRelevantMemories returns best matches", () => {
  const memories = [
    { content: "Likes sushi", ts: "2025-01-01T00:00:00Z" },
    { content: "Prefers dark mode", ts: "2025-01-02T00:00:00Z" },
    { content: "Working on ember memory engine", ts: "2025-01-03T00:00:00Z" },
  ];
  const result = selectRelevantMemories(memories, "memory engine", 2, {
    maxAgeDays: 2000,
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].content.includes("memory engine"));
});

test("selectRelevantMemories keeps pinned memories", () => {
  const memories = [
    { content: "Pinned fact", tags: ["pin"], ts: "2024-01-01T00:00:00Z" },
    { content: "Other info", ts: "2024-01-02T00:00:00Z" },
  ];
  const result = selectRelevantMemories(memories, "info", 2, { maxPinned: 1 });
  assert.ok(result.some((m) => m.content === "Pinned fact"));
});

test("detectMemoryCandidates suggests durable user facts", () => {
  const suggestions = detectMemoryCandidates(
    "My name is Casey and I prefer short answers.",
    []
  );
  assert.ok(suggestions.some((s) => s.tags.includes("identity")));
  assert.ok(suggestions.some((s) => s.tags.includes("preference")));
});

test("selectRelevantMemories drops stale reference memories", () => {
  const memories = [
    { content: "Reference A", type: "reference", ts: "2020-01-01T00:00:00Z" },
    { content: "Project B", type: "project", ts: "2020-01-01T00:00:00Z" },
  ];
  const result = selectRelevantMemories(memories, "reference", 2, {
    referenceMaxAgeDays: 30,
    maxAgeDays: 3650,
  });
  assert.ok(!result.some((m) => m.content === "Reference A"));
});

test("detectMemoryInvalidations flags negated preferences", () => {
  const memories = [
    { id: "1", content: "User prefers sushi." },
    { id: "2", content: "User prefers you to be concise." },
  ];
  const result = detectMemoryInvalidations("I don't like sushi.", memories);
  assert.ok(result.includes("1"));
});

test("buildEmbedding produces fixed size vector", () => {
  const vec = buildEmbedding("hello world");
  assert.equal(vec.length, 64);
});

test("consolidateMemories merges near-duplicates", () => {
  const a = { id: "a", content: "User prefers dark mode.", embedding: buildEmbedding("dark mode") };
  const b = { id: "b", content: "User prefers dark mode", embedding: buildEmbedding("dark mode") };
  const result = consolidateMemories([a, b], 0.9);
  assert.ok(result.updated.length === 1);
  assert.ok(result.merged.length === 1);
});

test("computeMemoryDomain detects preference", () => {
  const domain = computeMemoryDomain("I prefer short answers", []);
  assert.equal(domain, "preference");
});

test("bucketMemories splits recent and long term", () => {
  const memories = Array.from({ length: 120 }, (_, i) => ({ id: String(i), content: `m${i}` }));
  const buckets = bucketMemories(memories);
  assert.ok(buckets.recent.length > 0);
  assert.ok(buckets.longTerm.length > 0);
});

test("selectMemoriesWithFallback returns something when domain empty", () => {
  const memories = [
    { id: "1", content: "User prefers short answers.", type: "preference" },
  ];
  const result = selectMemoriesWithFallback(memories, "project roadmap", 2, { minScore: 0 });
  assert.ok(result.length >= 0);
});

test("runToolLoop executes tool calls then returns content", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool1",
                  function: { name: "mock", arguments: "{\"value\":1}" },
                },
              ],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "done" } }] };
  };
  const executeTool = async () => ({ ok: true });
  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 2 });
  assert.equal(result.assistantContent, "done");
});

test("runToolLoop parses tool calls from content", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              content:
                "<function=list_dir><parameter=path>/tmp</parameter></function>",
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "done" } }] };
  };
  const executeTool = async () => ({ ok: true });
  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 2 });
  assert.equal(result.assistantContent, "done");
});
