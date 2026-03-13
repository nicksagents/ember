import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_IP_COMMAND,
  TAILSCALE_IPV4_COMMAND,
  HOSTNAME_COMMAND,
  normalizeCommandText,
  matchesCommandHint,
  classifyLocalMachineInfoTask,
  buildExecutionPlan,
  formatExecutionPlanNote,
} from "./orchestration.mjs";

test("classifyLocalMachineInfoTask detects local and tailscale IP requests", () => {
  const task = classifyLocalMachineInfoTask(
    "whats the IP address of this machine and the tailscale ip"
  );
  assert.deepEqual(task, {
    wantsLocalIp: true,
    wantsTailscaleIp: true,
    wantsHostname: false,
  });
});

test("classifyLocalMachineInfoTask ignores normal chat", () => {
  const task = classifyLocalMachineInfoTask("tell me a joke");
  assert.equal(task, null);
});

test("normalizeCommandText compresses whitespace and casing", () => {
  assert.equal(
    normalizeCommandText("  TAILSCALE   ip   -4 "),
    "tailscale ip -4"
  );
});

test("matchesCommandHint supports exact and partial command checks", () => {
  assert.equal(matchesCommandHint(LOCAL_IP_COMMAND, "hostname -i"), true);
  assert.equal(matchesCommandHint(TAILSCALE_IPV4_COMMAND, "tailscale ip -4"), true);
  assert.equal(
    matchesCommandHint(` ${HOSTNAME_COMMAND} `, HOSTNAME_COMMAND, { exact: true }),
    true
  );
  assert.equal(
    matchesCommandHint(LOCAL_IP_COMMAND, HOSTNAME_COMMAND, { exact: true }),
    false
  );
});

test("buildExecutionPlan creates local machine inspection steps", () => {
  const plan = buildExecutionPlan({
    userContent: "show the IP address of this machine and tailscale ip",
    localMachineTask: {
      wantsLocalIp: true,
      wantsTailscaleIp: true,
      wantsHostname: false,
    },
    toolGuide: "[Tool guide]\n- run_command: Run a bash shell command.",
  });

  assert.equal(plan.steps.length >= 2, true);
  assert.ok(plan.steps.some((step) => step.includes("local IP")));
  assert.ok(plan.steps.some((step) => step.includes("Tailscale")));
  assert.ok(plan.steps.some((step) => step.includes("(run_command)")));
  const note = formatExecutionPlanNote(plan);
  assert.ok(note.includes("[Execution plan]"));
  assert.ok(note.includes("[Tool guide]"));
  assert.ok(note.includes("keep going until the request is complete"));
});

test("buildExecutionPlan includes a memory save step when memory candidates exist", () => {
  const plan = buildExecutionPlan({
    userContent: "my favorite editor is neovim",
    memoryItems: [
      {
        content: "User prefers Neovim.",
        type: "preference",
        tags: ["preference"],
      },
    ],
  });

  assert.ok(
    plan.steps.some((step) =>
      step.includes("Save the durable memory candidates with save_memory")
    )
  );
});

test("buildExecutionPlan avoids read_file for simple directory listing requests", () => {
  const plan = buildExecutionPlan({
    userContent:
      "list off the items in my Desktop and confirm there's a folder called bank",
    isReadOnlyFsRequest: true,
  });

  assert.ok(plan.steps.some((step) => step.includes("(list_dir)")));
  assert.ok(plan.steps.some((step) => step.includes("(stat_path)")));
  assert.ok(!plan.steps.some((step) => step.includes("(read_file)")));
});

test("buildExecutionPlan includes write_file for targeted edit requests", () => {
  const plan = buildExecutionPlan({
    userContent:
      "inside the bank folder edit page.tsx to resemble a modern sleek bank dashboard",
    recentProjectDir: "/home/agent_t560/Desktop/bank",
  });

  assert.ok(plan.steps.some((step) => step.includes("(list_dir)")));
  assert.ok(plan.steps.some((step) => step.includes("(read_file)")));
  assert.ok(plan.steps.some((step) => step.includes("(write_file)")));
});
