import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyLlamaCppEndpoint,
  shouldUsePromptOnlyTools,
  extractUnsupportedPayloadParams,
  stripUnsupportedPayloadParams,
} from "./provider-compat.mjs";

test("isLikelyLlamaCppEndpoint detects default local llama-server endpoint", () => {
  assert.equal(
    isLikelyLlamaCppEndpoint("http://localhost:8080/v1/chat/completions"),
    true
  );
  assert.equal(
    isLikelyLlamaCppEndpoint("http://127.0.0.1:8080/v1/chat/completions"),
    true
  );
  assert.equal(
    isLikelyLlamaCppEndpoint("http://localhost:1234/v1/chat/completions"),
    false
  );
});

test("shouldUsePromptOnlyTools enables llama.cpp prompt-only mode for qwen coder", () => {
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "http://localhost:8080/v1/chat/completions",
      modelName: "Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf",
    }),
    true
  );
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "http://localhost:8080/v1/chat/completions",
      modelName: "gpt-4.1",
    }),
    false
  );
});

test("extractUnsupportedPayloadParams parses common server error formats", () => {
  assert.deepEqual(
    extractUnsupportedPayloadParams('Unsupported param: tools'),
    ["tools"]
  );
  assert.deepEqual(
    extractUnsupportedPayloadParams('unknown field "tool_choice"'),
    ["tool_choice"]
  );
});

test("stripUnsupportedPayloadParams removes blocked fields and linked tool_choice", () => {
  const stripped = stripUnsupportedPayloadParams(
    {
      model: "qwen",
      tools: [{ type: "function" }],
      tool_choice: "auto",
      cache_prompt: false,
    },
    ["tools"]
  );
  assert.equal("tools" in stripped, false);
  assert.equal("tool_choice" in stripped, false);
  assert.equal(stripped.cache_prompt, false);
});
