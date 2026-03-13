import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeServerTaskRequest,
  classifyProcessTask,
} from "./process-intent.mjs";

test("looksLikeServerTaskRequest detects real server requests", () => {
  assert.equal(
    looksLikeServerTaskRequest("Can you host that bank project live on a server for me"),
    true
  );
  assert.equal(
    looksLikeServerTaskRequest("Sweet now kill the process running on port 3000"),
    true
  );
  assert.equal(
    looksLikeServerTaskRequest("Can you verify localhost:3000 is running"),
    true
  );
});

test("looksLikeServerTaskRequest ignores casual setup chatter", () => {
  assert.equal(
    looksLikeServerTaskRequest(
      "I have this LLM model running on my Mac hosting an api and I host a webchat live on a local server"
    ),
    false
  );
  assert.equal(
    looksLikeServerTaskRequest(
      "It is cool that this all runs locally and I can connect over Tailscale from my phone"
    ),
    false
  );
});

test("classifyProcessTask returns null for casual server mentions", () => {
  assert.equal(
    classifyProcessTask(
      "My second Lenovo is running the agent framework and I host a webchat on a local server"
    ),
    null
  );
});
