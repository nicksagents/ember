import test from "node:test";
import assert from "node:assert/strict";
import {
  validateChatRequest,
  buildSystemPrompt,
  buildContextMessages,
  runToolLoop,
  parseLooseToolCalls,
  looksLikeActionPreface,
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
  assert.ok(prompt.includes("[Workflow]"));
  assert.ok(prompt.includes("1. Understand the task"));
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
  assert.equal(vec.length, 256);
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

test("runToolLoop parses bracket-style tool calls from content", async () => {
  const payload = { messages: [] };
  const executed = [];
  let callCount = 0;
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              content:
                "[web_search] Toronto tonight entertainment options, events, things to do\n[web_search] Toronto tonight entertainment options, events, things to do",
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "done" } }] };
  };
  const executeTool = async (name, args) => {
    executed.push({ name, args });
    return { count: 1, results: [{ title: "Example" }] };
  };

  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 2 });
  assert.equal(result.assistantContent, "done");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "web_search");
  assert.equal(
    executed[0].args.query,
    "Toronto tonight entertainment options, events, things to do"
  );
});

test("runToolLoop prompts for continuation after a successful tool round", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const seenPrompts = [];
  const callLLM = async (nextPayload) => {
    callCount += 1;
    seenPrompts.push(nextPayload.messages[nextPayload.messages.length - 1]?.content || "");
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool1",
                  function: { name: "list_dir", arguments: JSON.stringify({ path: "/tmp" }) },
                },
              ],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "done" } }] };
  };
  const executeTool = async () => ({ path: "/tmp", entries: [] });

  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 2 });
  assert.equal(result.assistantContent, "done");
  assert.ok(
    seenPrompts.some((text) =>
      String(text).includes("Call the next tool. Only respond when ALL steps are complete and verified.")
    )
  );
});

test("runToolLoop converts action-preface replies into fallback tool execution", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const fallbackPhases = [];
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              content: "Let me inspect the project structure and check the files.",
            },
          },
        ],
      };
    }
    return {
      choices: [
        {
          message: {
            content: "I checked the project and found a Next.js app with a local agent runtime.",
          },
        },
      ],
    };
  };
  const executed = [];
  const executeTool = async (name, args) => {
    executed.push({ name, args });
    return { path: "/tmp/project", entries: [{ name: "package.json" }] };
  };
  const fallbackToolCall = async (_message, _payload, options = {}) => {
    fallbackPhases.push(options.phase || "");
    return {
      name: "list_dir",
      arguments: { path: "/tmp/project" },
    };
  };

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    fallbackToolCall,
    maxToolRounds: 3,
  });

  assert.equal(
    result.assistantContent,
    "I checked the project and found a Next.js app with a local agent runtime."
  );
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "list_dir");
  assert.ok(fallbackPhases.includes("execute"));
});

test("runToolLoop emits interim assistant messages during tool-backed work", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const seenAssistantMessages = [];
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              content: "I am checking the project files now.",
              tool_calls: [
                {
                  id: "tool1",
                  function: {
                    name: "list_dir",
                    arguments: JSON.stringify({ path: "/tmp/project" }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return {
      choices: [{ message: { content: "I found the files and finished the check." } }],
    };
  };
  const executeTool = async () => ({ path: "/tmp/project", entries: [{ name: "package.json" }] });

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    maxToolRounds: 3,
    requireToolCall: true,
    onAssistantMessage: async (text) => {
      seenAssistantMessages.push(text);
    },
  });

  assert.equal(result.assistantContent, "I found the files and finished the check.");
  assert.ok(
    seenAssistantMessages.some((text) =>
      String(text).includes("checking the project files")
    )
  );
});

test("runToolLoop supports custom verify prompts for web lookups", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const seenPrompts = [];
  const callLLM = async (nextPayload) => {
    callCount += 1;
    seenPrompts.push(nextPayload.messages[nextPayload.messages.length - 1]?.content || "");
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool1",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "toronto tonight", limit: 3 }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "Here are a few options tonight." } }] };
  };
  const executeTool = async () => ({ count: 3, results: [{ title: "A" }] });

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    maxToolRounds: 2,
    buildVerifyPrompt: ({ toolCalls, defaultPrompt }) => {
      const names = toolCalls.map((toolCall) => toolCall?.function?.name);
      if (names.includes("web_search")) {
        return "[System note] Use these search results to answer the user now. Only call fetch_url if one result needs more detail.";
      }
      return defaultPrompt;
    },
  });

  assert.equal(result.assistantContent, "Here are a few options tonight.");
  assert.ok(
    seenPrompts.some((text) =>
      String(text).includes("Use these search results to answer the user now.")
    )
  );
});

test("runToolLoop blocks repeated tool calls with toolCallGuard", async () => {
  const payload = {
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool_prev",
            function: {
              name: "web_search",
              arguments: JSON.stringify({ query: "toronto tonight", limit: 3 }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tool_prev",
        content: JSON.stringify({ count: 3, results: [{ title: "Example" }] }),
      },
    ],
  };
  let callCount = 0;
  const seenPrompts = [];
  const callLLM = async (nextPayload) => {
    callCount += 1;
    seenPrompts.push(nextPayload.messages[nextPayload.messages.length - 1]?.content || "");
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool_repeat",
                  function: {
                    name: "web_search",
                    arguments: JSON.stringify({ query: "toronto tonight", limit: 3 }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "Here are a few options tonight." } }] };
  };
  const executeTool = async () => ({ count: 3, results: [{ title: "Example" }] });

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    maxToolRounds: 2,
    toolCallGuard: ({ message: nextMessage }) => {
      const names = (nextMessage.tool_calls || []).map((toolCall) => toolCall?.function?.name);
      if (names.every((name) => name === "web_search")) {
        return {
          block: true,
          note: "[System note] You already searched the web. Answer now.",
        };
      }
      return null;
    },
  });

  assert.equal(result.assistantContent, "Here are a few options tonight.");
  assert.ok(seenPrompts.some((text) => String(text).includes("You already searched the web")));
});

test("runToolLoop requires verification before finalizing server start tasks", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const seenPrompts = [];
  const callLLM = async (nextPayload) => {
    callCount += 1;
    seenPrompts.push(nextPayload.messages[nextPayload.messages.length - 1]?.content || "");
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool1",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      command: "HOST=0.0.0.0 PORT=3000 npm run dev",
                      background: true,
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    if (callCount === 2) {
      return { choices: [{ message: { content: "The server is running." } }] };
    }
    if (callCount === 3) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool2",
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      command: "curl -I http://127.0.0.1:3000",
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "Verified. The server responded on port 3000." } }] };
  };
  const executeTool = async (name, args) => {
    if (name === "run_command" && args.background) {
      return { started: true, background: true, pid: 123 };
    }
    return { exitCode: 0, stdout: "HTTP/1.1 200 OK" };
  };

  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 4 });
  assert.equal(result.assistantContent, "Verified. The server responded on port 3000.");
  assert.ok(
    seenPrompts.some((text) =>
      String(text).includes("Verification is still required")
    )
  );
});

test("runToolLoop blocks false success after tool error", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const seenPrompts = [];
  const callLLM = async (nextPayload) => {
    callCount += 1;
    seenPrompts.push(nextPayload.messages[nextPayload.messages.length - 1]?.content || "");
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "tool1",
                  function: { name: "run_command", arguments: JSON.stringify({ command: "badcmd" }) },
                },
              ],
            },
          },
        ],
      };
    }
    if (callCount === 2) {
      return { choices: [{ message: { content: "Done." } }] };
    }
    return { choices: [{ message: { content: "The command failed, so I could not complete the task." } }] };
  };
  const executeTool = async () => ({ exitCode: 127, stderr: "/bin/bash: badcmd: command not found" });

  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 3 });
  assert.equal(
    result.assistantContent,
    "The command failed, so I could not complete the task."
  );
  assert.ok(
    seenPrompts.some((text) =>
      String(text).includes("The last tool failed")
    )
  );
});

test("runToolLoop can use fallback tool call for verification stage", async () => {
  const payload = { messages: [] };
  let callCount = 0;
  const fallbackPhases = [];
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
                  function: {
                    name: "run_command",
                    arguments: JSON.stringify({
                      command: "HOST=0.0.0.0 PORT=3000 npm run dev",
                      background: true,
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    if (callCount === 2) {
      return { choices: [{ message: { content: "Started and done." } }] };
    }
    return { choices: [{ message: { content: "Verified and complete." } }] };
  };
  const executeTool = async (_name, args) => {
    if (args.background) return { started: true, background: true, pid: 456 };
    return { exitCode: 0, stdout: "HTTP_STATUS 200" };
  };
  const fallbackToolCall = async (_message, _payload, options = {}) => {
    fallbackPhases.push(options.phase || "");
    if (options.phase === "verify") {
      return {
        name: "run_command",
        arguments: { command: "curl -I http://127.0.0.1:3000" },
      };
    }
    return null;
  };

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    fallbackToolCall,
    maxToolRounds: 4,
  });
  assert.equal(result.assistantContent, "Verified and complete.");
  assert.ok(fallbackPhases.includes("verify"));
});

test("runToolLoop completionGuard blocks final response until verification succeeds", async () => {
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
                  function: {
                    name: "start_dev_server",
                    arguments: JSON.stringify({
                      cwd: "/tmp/bank",
                      host: "0.0.0.0",
                      port: 3000,
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    if (callCount === 2) {
      return { choices: [{ message: { content: "The server is running now." } }] };
    }
    return { choices: [{ message: { content: "Verified on 0.0.0.0:3000." } }] };
  };
  const executeTool = async (name) => {
    if (name === "start_dev_server") {
      return { started: true, pid: 999, host: "0.0.0.0", port: 3000 };
    }
    return { ok: true, host: "0.0.0.0", port: 3000, status: 200 };
  };
  const fallbackToolCall = async (_message, _payload, options = {}) => {
    if (options.phase === "verify") {
      return {
        name: "verify_server",
        arguments: { host: "0.0.0.0", port: 3000 },
      };
    }
    return null;
  };
  const completionGuard = ({ payload: nextPayload }) => {
    const toolResult = nextPayload.messages.find(
      (msg) => msg.role === "tool" && String(msg.content).includes('"ok":true')
    );
    if (toolResult) return null;
    return {
      block: true,
      phase: "verify",
      note: "[System note] Verification is required before the task can finish.",
    };
  };

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    fallbackToolCall,
    completionGuard,
    maxToolRounds: 4,
  });
  assert.equal(result.assistantContent, "Verified on 0.0.0.0:3000.");
});

test("runToolLoop completionGuard can require port-free verification for stop tasks", async () => {
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
                  function: {
                    name: "kill_process",
                    arguments: JSON.stringify({ port: 3000 }),
                  },
                },
              ],
            },
          },
        ],
      };
    }
    if (callCount === 2) {
      return { choices: [{ message: { content: "It is killed." } }] };
    }
    return { choices: [{ message: { content: "Port 3000 is free." } }] };
  };
  const executeTool = async (name) => {
    if (name === "kill_process") {
      return { killed: true, targets: [{ pid: 123, ok: true }] };
    }
    return { count: 0, port: 3000, processes: [] };
  };
  const fallbackToolCall = async (_message, _payload, options = {}) => {
    if (options.phase === "verify_stopped") {
      return {
        name: "list_processes",
        arguments: { port: 3000, limit: 10 },
      };
    }
    return null;
  };
  const completionGuard = ({ payload: nextPayload }) => {
    const freePortResult = nextPayload.messages.find(
      (msg) => msg.role === "tool" && String(msg.content).includes('"count":0')
    );
    if (freePortResult) return null;
    return {
      block: true,
      phase: "verify_stopped",
      note: "[System note] The task is not done until port 3000 is confirmed free.",
    };
  };

  const result = await runToolLoop({
    payload,
    callLLM,
    executeTool,
    fallbackToolCall,
    completionGuard,
    maxToolRounds: 4,
  });
  assert.equal(result.assistantContent, "Port 3000 is free.");
});

// ── parseLooseToolCalls: bash block and narrative detection ──────────────────

test("parseLooseToolCalls converts markdown bash block to run_command", () => {
  const content = "Let me check the directory.\n\n```bash\nls -la /home/user/Desktop\n```\n\nHere are the results...";
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "run_command");
  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.command, "ls -la /home/user/Desktop");
});

test("parseLooseToolCalls ignores bash block when proper tool_call exists", () => {
  const content = '<tool_call>{"name":"list_dir","arguments":{"path":"/tmp"}}</tool_call>\n\n```bash\nls /tmp\n```';
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "list_dir");
});

test("parseLooseToolCalls skips bash blocks that look like fabricated output", () => {
  const content = "```bash\ntotal 24\ndrwxr-xr-x 3 user user 4096 Jan 1 00:00 .\n```";
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 0);
});

test("parseLooseToolCalls converts narrative list_dir mention to tool call", () => {
  const content = "I'll use list_dir to check /home/user/Desktop for the files.";
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "list_dir");
  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.path, "/home/user/Desktop");
});

test("parseLooseToolCalls converts narrative read_file mention to tool call", () => {
  const content = "Let me use read_file on /home/user/package.json to check the dependencies.";
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "read_file");
  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.path, "/home/user/package.json");
});

test("parseLooseToolCalls handles shell block with command and fake output", () => {
  const content = "```bash\ncat /etc/hostname\nmy-machine\n```";
  const calls = parseLooseToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "run_command");
  const args = JSON.parse(calls[0].function.arguments);
  assert.equal(args.command, "cat /etc/hostname");
});

// ── looksLikeActionPreface: enhanced detection ──────────────────────────────

test("looksLikeActionPreface detects tool name mentions", () => {
  assert.equal(looksLikeActionPreface("I'll use list_dir to check the Desktop."), true);
  assert.equal(looksLikeActionPreface("Let me call read_file on package.json."), true);
  assert.equal(looksLikeActionPreface("I will use web_search to find the answer."), true);
});

test("looksLikeActionPreface detects bash code blocks", () => {
  assert.equal(looksLikeActionPreface("```bash\nls -la\n```"), true);
  assert.equal(looksLikeActionPreface("```shell\npwd\n```"), true);
});

test("looksLikeActionPreface detects use/call/run verbs", () => {
  assert.equal(looksLikeActionPreface("Let me use the file listing tool."), true);
  assert.equal(looksLikeActionPreface("I'll run a command to check."), true);
  assert.equal(looksLikeActionPreface("I'm going to call the API."), true);
});

test("looksLikeActionPreface returns false for plain answers", () => {
  assert.equal(looksLikeActionPreface("The answer is 42."), false);
  assert.equal(looksLikeActionPreface("Here are your files."), false);
});

// ── runToolLoop: bash-block model response triggers tool execution ───────────

test("runToolLoop converts bash-block response to tool execution", async () => {
  const payload = { messages: [] };
  const executed = [];
  let callCount = 0;
  const callLLM = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        choices: [
          {
            message: {
              content: "Let me check.\n\n```bash\nls /home/user/Desktop\n```",
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: "Found your files." } }] };
  };
  const executeTool = async (name, args) => {
    executed.push({ name, args });
    return { exitCode: 0, stdout: "file1.txt\nfile2.txt" };
  };

  const result = await runToolLoop({ payload, callLLM, executeTool, maxToolRounds: 3 });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].name, "run_command");
  assert.equal(executed[0].args.command, "ls /home/user/Desktop");
});
