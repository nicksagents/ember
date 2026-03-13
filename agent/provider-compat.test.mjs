import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPayloadCompatKey,
  normalizePayloadCompatCache,
  getCachedUnsupportedPayloadParams,
  mergeUnsupportedPayloadParams,
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
    true
  );
});

test("shouldUsePromptOnlyTools supports auto, xml, and native modes", () => {
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "http://localhost:8080/v1/chat/completions",
      modelName: "Qwen3-Coder-30B-A3B-Instruct-Q6_K.gguf",
    }),
    true
  );
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "https://api.openai.com/v1/chat/completions",
      modelName: "gpt-4.1",
    }),
    false
  );
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "https://api.openai.com/v1/chat/completions",
      toolMode: "xml",
    }),
    true
  );
  assert.equal(
    shouldUsePromptOnlyTools({
      endpoint: "http://localhost:8080/v1/chat/completions",
      toolMode: "native",
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

test("payload compat helpers normalize keys and merge unsupported params", () => {
  assert.equal(buildPayloadCompatKey(" OpenAI ", "GPT-5"), "openai::gpt-5");
  assert.deepEqual(
    normalizePayloadCompatCache({
      "OpenAI::GPT-5": ["Temperature", "top_p"],
      "bad-key": ["ignored"],
    }),
    {
      "openai::gpt-5": ["temperature", "top_p"],
    }
  );
});

test("payload compat helpers resolve provider+model disabled params", () => {
  const merged = mergeUnsupportedPayloadParams(
    {
      "openai::gpt-5": ["temperature"],
    },
    {
      providerId: "openai",
      model: "gpt-5",
      unsupportedParams: ["top_p"],
    }
  );
  assert.equal(merged.changed, true);
  assert.deepEqual(
    getCachedUnsupportedPayloadParams(merged.cache, {
      providerId: "openai",
      model: "gpt-5",
    }),
    ["top_p", "temperature"]
  );
  assert.deepEqual(
    getCachedUnsupportedPayloadParams(merged.cache, {
      providerId: "openai",
      model: "gpt-4.1",
    }),
    ["top_p"]
  );
});
