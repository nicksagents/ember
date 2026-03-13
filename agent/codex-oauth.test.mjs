import test from "node:test";
import assert from "node:assert/strict";

import {
  getCodexCallbackUrl,
  parseCodexRedirectUrl,
} from "./codex-oauth.mjs";

test("getCodexCallbackUrl matches the fixed Codex callback contract", () => {
  assert.equal(getCodexCallbackUrl(), "http://localhost:1455/auth/callback");
});

test("parseCodexRedirectUrl extracts code and state from the redirect URL", () => {
  const result = parseCodexRedirectUrl(
    "http://localhost:1455/auth/callback?code=abc123&state=flow-1"
  );
  assert.equal(result.code, "abc123");
  assert.equal(result.state, "flow-1");
  assert.equal(result.error, "");
});

test("parseCodexRedirectUrl accepts 127.0.0.1 redirects for compatibility", () => {
  const result = parseCodexRedirectUrl(
    "http://127.0.0.1:1455/auth/callback?code=abc123&state=flow-1"
  );
  assert.equal(result.code, "abc123");
  assert.equal(result.state, "flow-1");
});

test("parseCodexRedirectUrl rejects non-callback URLs", () => {
  assert.throws(
    () => parseCodexRedirectUrl("http://localhost:1455/wrong?code=abc&state=flow-1"),
    /Expected redirect URL ending in \/auth\/callback/
  );
});
