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
  // Uses real tool name from the first definition as the example
  assert.ok(message.includes('{"name":"run_command","arguments":{"command":"..."}'));
  assert.ok(message.includes("NEVER use ```bash"));
  assert.ok(message.includes("NEVER fabricate command output"));
  assert.ok(message.includes("NEVER describe what you will do"));
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
  assert.ok(prompt.includes("<tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call>"));
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
