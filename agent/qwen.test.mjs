import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "./tooling.mjs";
import {
  isQwenCoderModel,
  buildQwenXmlToolSystemMessage,
  buildQwenToolContinuationPrompt,
} from "./qwen.mjs";

test("isQwenCoderModel detects qwen coder variants", () => {
  assert.equal(
    isQwenCoderModel("Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf"),
    true
  );
  assert.equal(isQwenCoderModel("gpt-4.1"), false);
});

test("buildQwenXmlToolSystemMessage renders exact tool call guidance", () => {
  const message = buildQwenXmlToolSystemMessage([
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command string" },
          },
          required: ["command"],
        },
      },
    },
  ]);

  assert.ok(message.includes("<tools>"));
  assert.ok(message.includes("<function>"));
  assert.ok(message.includes("<name>run_command</name>"));
  assert.ok(message.includes("<tool_call>"));
  // Uses Qwen3-Coder native XML format: <function=name><parameter=name>value</parameter></function>
  assert.ok(message.includes("<function=run_command>"));
  assert.ok(message.includes("<parameter=command>"));
  assert.ok(message.includes("NEVER use ```bash"));
  assert.ok(message.includes("NEVER fabricate command output"));
  assert.ok(message.includes("NEVER describe what you will do"));
  assert.ok(message.includes("ALWAYS use <function=write_file>"));
});

test("buildQwenXmlToolSystemMessage includes write_file example when write_file is available", () => {
  const message = buildQwenXmlToolSystemMessage([
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "File content" },
          },
          required: ["path", "content"],
        },
      },
    },
  ]);
  assert.ok(message.includes("<function=write_file>"));
  assert.ok(message.includes("<parameter=path>/path/to/file.tsx</parameter>"));
  assert.ok(message.includes("<parameter=content>"));
  assert.ok(message.includes("NEVER paste code as plain text"));
});

test("buildQwenToolContinuationPrompt reminds about write_file after read_file for edits", () => {
  const prompt = buildQwenToolContinuationPrompt({
    toolCalls: [{ function: { name: "read_file" } }],
    toolResults: [{ role: "tool", content: "file contents here" }],
    defaultPrompt: "",
    toolStyle: "xml",
    editTargetPath: "/home/user/app/page.tsx",
  });
  assert.ok(prompt.includes("write_file"));
  assert.ok(prompt.includes("/home/user/app/page.tsx"));
  assert.ok(prompt.includes("COMPLETE updated file content"));
});

test("buildQwenToolContinuationPrompt includes tool results and exact format reminder", () => {
  const prompt = buildQwenToolContinuationPrompt({
    toolCalls: [
      {
        function: {
          name: "run_command",
        },
      },
    ],
    toolResults: [
      {
        content: '{"stdout":"192.168.1.10","stderr":"","exitCode":0}',
      },
    ],
    defaultPrompt: "[System note] Verify the change with a tool before responding.",
  });

  assert.ok(prompt.includes("[Tool result: run_command]"));
  assert.ok(prompt.includes("192.168.1.10"));
  assert.ok(prompt.includes("<tool_call><function=name><parameter=arg>value</parameter></function></tool_call>"));
  assert.ok(prompt.includes("Do NOT use ```bash blocks"));
});

test("buildQwenToolContinuationPrompt supports native tool mode", () => {
  const prompt = buildQwenToolContinuationPrompt({
    toolCalls: [],
    toolResults: [],
    defaultPrompt: "[System note] Continue.",
    toolStyle: "native",
  });

  assert.ok(prompt.includes("provided tool interface"));
  assert.ok(!prompt.includes("<tool_call>"));
});

test("buildQwenToolContinuationPrompt formats web_search results as readable text", () => {
  const prompt = buildQwenToolContinuationPrompt({
    toolCalls: [
      {
        function: {
          name: "web_search",
        },
      },
    ],
    toolResults: [
      {
        content: JSON.stringify({
          query: "news today",
          results: [
            {
              title: "CBC News",
              url: "https://www.cbc.ca/news",
              snippet: "Canada's latest breaking news and top stories.",
            },
            {
              title: "CNN",
              url: "https://www.cnn.com",
              snippet: "Breaking news, latest headlines, and live updates.",
            },
          ],
          count: 2,
        }),
      },
    ],
    defaultPrompt: "[System note] Answer now.",
  });

  assert.ok(prompt.includes('[Search results for "news today"]'));
  assert.ok(prompt.includes("1. CBC News - Canada's latest breaking news and top stories."));
  assert.ok(prompt.includes("URL: https://www.cbc.ca/news"));
  assert.ok(prompt.includes("Do NOT say you lack access to the content"));
  assert.ok(!prompt.includes('{"query":"news today"'));
});

test("buildQwenToolContinuationPrompt formats fetch_url results around extracted text", () => {
  const prompt = buildQwenToolContinuationPrompt({
    toolCalls: [
      {
        function: {
          name: "fetch_url",
        },
      },
    ],
    toolResults: [
      {
        content: JSON.stringify({
          url: "https://example.com/story",
          title: "Example Story",
          byline: "Reporter Name",
          publishedTime: "2026-02-28T10:00:00Z",
          text: "This is the main article text with the facts the model should summarize.",
          paywallLikely: false,
        }),
      },
    ],
    defaultPrompt: "[System note] Answer now.",
  });

  assert.ok(prompt.includes("[Fetched page: Example Story]"));
  assert.ok(prompt.includes("URL: https://example.com/story"));
  assert.ok(prompt.includes("Byline: Reporter Name"));
  assert.ok(prompt.includes("This is the main article text with the facts the model should summarize."));
  assert.ok(!prompt.includes('"paywallLikely":false'));
});

test("ToolRegistry.selectDefinitions narrows tool set to relevant tools", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    description: "Run a shell command.",
    parameters: { type: "object", properties: {} },
    keywords: ["run", "command", "shell"],
    handler: async () => ({}),
  });
  registry.register({
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: {} },
    keywords: ["read", "file"],
    handler: async () => ({}),
  });
  registry.register({
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: {} },
    keywords: ["web", "search"],
    handler: async () => ({}),
  });

  const defs = registry.selectDefinitions(
    "what is the IP address of this machine",
    2,
    ["run_command"]
  );
  const names = defs.map((def) => def.function.name);
  assert.ok(names.includes("run_command"));
  assert.equal(names.length <= 2, true);
});

test("ToolRegistry.selectDefinitions prefers specialized filesystem tools over run_command", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "run_command",
    description: "Run a shell command.",
    parameters: { type: "object", properties: {} },
    keywords: ["run", "command", "shell"],
    handler: async () => ({}),
  });
  registry.register({
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: {} },
    keywords: ["read", "file", "open", "view"],
    handler: async () => ({}),
  });
  registry.register({
    name: "list_dir",
    description: "List a directory.",
    parameters: { type: "object", properties: {} },
    keywords: ["list", "directory", "folder", "files"],
    handler: async () => ({}),
  });

  const defs = registry.selectDefinitions(
    "read the package.json file and show me the folder contents",
    2
  );
  const names = defs.map((def) => def.function.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("list_dir"));
  assert.ok(!names.includes("run_command"));
});

test("ToolRegistry.selectDefinitions includes search_file for targeted file inspection", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "search_file",
    description: "Search a file for text and return matching lines.",
    parameters: { type: "object", properties: {} },
    keywords: ["search", "find", "contains", "label"],
    handler: async () => ({}),
  });
  registry.register({
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: {} },
    keywords: ["read", "file", "inspect"],
    handler: async () => ({}),
  });
  registry.register({
    name: "run_command",
    description: "Run a shell command.",
    parameters: { type: "object", properties: {} },
    keywords: ["run", "command", "shell"],
    handler: async () => ({}),
  });

  const defs = registry.selectDefinitions(
    "inspect components/settings-form.tsx and tell me whether it exposes Max tool rounds",
    2
  );
  const names = defs.map((def) => def.function.name);
  assert.ok(names.includes("search_file"));
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("run_command"));
});
