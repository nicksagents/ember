import test from "node:test";
import assert from "node:assert/strict";
import { describeProviderAuth, resolveProviderApiKey } from "./auth-sources.mjs";

test("resolveProviderApiKey prefers agent-stored token for codex oauth", async () => {
  const token = await resolveProviderApiKey({
    authType: "codex-oauth",
    apiKey: "stored-codex-token",
  });
  assert.equal(token, "stored-codex-token");
});

test("resolveProviderApiKey prefers agent-stored token for claude oauth", async () => {
  const token = await resolveProviderApiKey({
    authType: "claude-code-oauth",
    apiKey: "stored-claude-token",
  });
  assert.equal(token, "stored-claude-token");
});

test("describeProviderAuth reflects agent-managed oauth tokens", () => {
  assert.equal(
    describeProviderAuth({ authType: "codex-oauth", apiKey: "stored-codex-token" }),
    "Agent-managed Codex OAuth token"
  );
  assert.equal(
    describeProviderAuth({
      authType: "claude-code-oauth",
      apiKey: "stored-claude-token",
    }),
    "Agent-managed Anthropic setup-token"
  );
});
