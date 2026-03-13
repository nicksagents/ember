import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexWsPayload, buildCodexWsRequest } from "./openai-codex-ws.mjs";

test("buildCodexWsRequest uses full input when there is no previous response", () => {
  const result = buildCodexWsRequest({
    previousResponseId: "",
    lastMessageCount: 0,
    messageCount: 2,
    messageItemCounts: [0, 1],
    input: [{ type: "message", role: "user", content: "hello" }],
  });

  assert.equal(result.incremental, false);
  assert.equal(result.previousResponseId, "");
  assert.deepEqual(result.input, [{ type: "message", role: "user", content: "hello" }]);
});

test("buildCodexWsRequest sends only new items when a previous response exists", () => {
  const result = buildCodexWsRequest({
    previousResponseId: "resp_prev",
    lastMessageCount: 2,
    messageCount: 4,
    messageItemCounts: [0, 1, 2, 1],
    input: [
      { type: "message", role: "user", content: "build app" },
      { type: "message", role: "assistant", content: "working" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
  });

  assert.equal(result.incremental, true);
  assert.equal(result.previousResponseId, "resp_prev");
  assert.deepEqual(result.input, [
    { type: "message", role: "assistant", content: "working" },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ]);
});

test("buildCodexWsPayload drops disabled params before sending websocket request", () => {
  const payload = buildCodexWsPayload({
    model: "gpt-5.3-codex",
    input: [{ type: "message", role: "user", content: "hello" }],
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ],
    toolChoice: "auto",
    disabledParams: ["truncation", "tool_choice"],
  });

  assert.equal("truncation" in payload, false);
  assert.equal("tool_choice" in payload, false);
  assert.equal(Array.isArray(payload.tools), true);
});
