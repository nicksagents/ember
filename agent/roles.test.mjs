import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ROLES,
  canRoleDelegate,
  canRoleUseTool,
  buildRoleContractPrompt,
} from "./roles.mjs";

test("coder role includes scaffold tools", () => {
  const allowedTools = AGENT_ROLES.coder.allowedTools;
  assert.ok(allowedTools.includes("scaffold_project"));
  assert.ok(allowedTools.includes("scaffold_next_shadcn_project"));
});

test("default role is user-facing and cannot edit files directly", () => {
  assert.equal(AGENT_ROLES.default.canChatWithUser, true);
  assert.equal(canRoleUseTool("default", "write_file"), false);
  assert.equal(canRoleUseTool("default", "start_dev_server"), true);
});

test("planner and auditor delegation graph is explicit", () => {
  assert.equal(canRoleDelegate("planner", "coder"), true);
  assert.equal(canRoleDelegate("planner", "default"), true);
  assert.equal(canRoleDelegate("planner", "auditor"), false);
  assert.equal(canRoleDelegate("auditor", "coder"), true);
  assert.equal(canRoleDelegate("coder", "default"), false);
});

test("role contract prompt includes tools and delegation targets", () => {
  const prompt = buildRoleContractPrompt("coder");
  assert.ok(prompt.includes("allowed_tools:"));
  assert.ok(prompt.includes("delegation_targets: auditor, planner, maintenance"));
  assert.ok(prompt.includes("[Role rules]"));
});

test("planner has the same inspection tool access as default plus routing contract", () => {
  const plannerTools = new Set(AGENT_ROLES.planner.allowedTools);
  for (const toolName of AGENT_ROLES.default.allowedTools) {
    assert.equal(plannerTools.has(toolName), true);
  }
  assert.equal(AGENT_ROLES.planner.systemPromptPrefix.includes("ground zero"), true);
});
