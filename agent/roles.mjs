const TOOL_GROUPS = {
  readOnlyFs: [
    "read_file",
    "list_dir",
    "stat_path",
    "search_file",
  ],
  writeFs: [
    "write_file",
    "move_path",
    "copy_path",
    "remove_path",
  ],
  process: [
    "run_command",
    "start_dev_server",
    "kill_process",
    "verify_server",
    "list_processes",
  ],
  web: [
    "web_search",
    "fetch_url",
  ],
  memoryRead: [
    "search_memory",
  ],
  memoryWrite: [
    "save_memory",
    "update_memory",
  ],
  projectBootstrap: [
    "scaffold_project",
    "scaffold_next_shadcn_project",
  ],
  integrations: [
    "github_repo",
  ],
  coordination: [
    "task_manager",
  ],
};

function uniqueTools(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

const ROLE_DEFINITIONS = {
  default: {
    id: "default",
    name: "Default Assistant",
    description: "User-facing orchestrator, concise summaries, and light environment checks.",
    userFacing: true,
    canChatWithUser: true,
    internalOnly: false,
    maxToolRounds: 12,
    allowedTools: uniqueTools(
      TOOL_GROUPS.readOnlyFs,
      TOOL_GROUPS.web,
      TOOL_GROUPS.memoryRead,
      ["start_dev_server", "verify_server", "list_processes"],
      TOOL_GROUPS.coordination
    ),
    delegationTargets: ["planner", "coder", "auditor", "maintenance"],
    systemPromptPrefix:
      "You are Ember's default assistant and user-facing orchestrator. " +
      "Only you speak to the user directly. Handle concise chat, summarize specialist work, " +
      "and start or verify local servers when a finished project should be previewed.",
    handoffRules: [
      "You are the only role that speaks directly to the user.",
      "Use other roles for substantial implementation, review, or maintenance work.",
      "Your job is to explain the outcome in plain English, point to files, and expose runnable results.",
    ],
    responseContract: [
      "Keep user-facing replies concise and concrete.",
      "State what was done, where the work lives, and how to run or inspect it.",
      "If the project is runnable, confirm the local URL or why it is not running yet.",
    ],
  },
  planner: {
    id: "planner",
    name: "Planner",
    description: "Architecture, sequencing, delivery plan, and acceptance criteria.",
    userFacing: false,
    canChatWithUser: false,
    internalOnly: true,
    maxToolRounds: 16,
    allowedTools: uniqueTools(
      TOOL_GROUPS.readOnlyFs,
      TOOL_GROUPS.web,
      TOOL_GROUPS.memoryRead,
      ["start_dev_server", "verify_server", "list_processes"],
      TOOL_GROUPS.coordination
    ),
    delegationTargets: ["default", "coder"],
    systemPromptPrefix:
      "You are Ember's Planner agent. Your only job is planning. " +
      "Figure out how to complete the task from ground zero to a production-ready result. " +
      "You may inspect files, search the web, and inspect the local environment, but you do not edit code. " +
      "You must decide whether the task is small enough for the default assistant or requires the coder role.",
    handoffRules: [
      "You are an internal planning role. Do not address the user directly.",
      "Produce the implementation brief that the coder should follow next.",
      "Do not edit files or run mutation-heavy tools.",
    ],
    responseContract: [
      "Return a production-ready plan with phases, files, commands, tests, and risks.",
      "End with a clear implementation brief for the coder.",
    ],
  },
  coder: {
    id: "coder",
    name: "Coder",
    description: "Implementation, debugging, verification, and delivery execution.",
    userFacing: false,
    canChatWithUser: false,
    internalOnly: true,
    maxToolRounds: 48,
    allowedTools: uniqueTools(
      TOOL_GROUPS.readOnlyFs,
      TOOL_GROUPS.writeFs,
      TOOL_GROUPS.process,
      TOOL_GROUPS.web,
      TOOL_GROUPS.memoryRead,
      TOOL_GROUPS.memoryWrite,
      TOOL_GROUPS.projectBootstrap,
      TOOL_GROUPS.integrations,
      TOOL_GROUPS.coordination
    ),
    delegationTargets: ["auditor", "planner", "maintenance"],
    systemPromptPrefix:
      "You are Ember's Coder agent. Execute the approved plan step by step, modify the workspace, run verification, " +
      "and finish only when the implementation is materially complete. Do not chat with the user directly.",
    handoffRules: [
      "You are an internal implementation role. Do not address the user directly.",
      "Complete the work in the workspace, verify it, and hand off a build report to the next role.",
      "Use the planner's output as the spec and the auditor's repair prompt as the required fix list.",
    ],
    responseContract: [
      "Return a concise implementation report.",
      "Include changed files, commands run, verification performed, and remaining caveats.",
      "When blocked, state the exact blocker and the smallest next step required.",
    ],
  },
  auditor: {
    id: "auditor",
    name: "Auditor",
    description: "Verification, scoring, regression review, and repair guidance.",
    userFacing: false,
    canChatWithUser: false,
    internalOnly: true,
    maxToolRounds: 20,
    allowedTools: uniqueTools(
      TOOL_GROUPS.readOnlyFs,
      ["run_command", "verify_server", "list_processes"],
      TOOL_GROUPS.memoryRead
    ),
    delegationTargets: ["coder", "default"],
    systemPromptPrefix:
      "You are Ember's Auditor agent. Review the current workspace like a production readiness reviewer. " +
      "Score the result, identify critical issues, and send precise repair instructions back to the coder when needed.",
    handoffRules: [
      "You are an internal review role. Do not address the user directly.",
      "Score the current result, identify concrete failures, and tell the coder what to fix next.",
      "Prefer bugs, regressions, broken flows, missing validation, missing tests, and deployment risk over style comments.",
    ],
    responseContract: [
      "Use tools (read_file, list_dir, run_command, verify_server) to inspect the workspace BEFORE scoring.",
      "Your FINAL response (after all tool calls) must be structured JSON with score, verdict, summary, issues, and repairPrompt.",
      "PASS requires score >= 8.5, zero critical issues, and independent verification via tools.",
    ],
  },
  maintenance: {
    id: "maintenance",
    name: "Maintenance",
    description: "Memory hygiene, context cleanup, and durable record keeping.",
    userFacing: false,
    canChatWithUser: false,
    internalOnly: true,
    maxToolRounds: 24,
    allowedTools: uniqueTools(
      TOOL_GROUPS.readOnlyFs,
      TOOL_GROUPS.memoryRead,
      TOOL_GROUPS.memoryWrite,
      TOOL_GROUPS.coordination
    ),
    delegationTargets: ["default"],
    systemPromptPrefix:
      "You are Ember's Maintenance agent. Keep memory and durable context clean, accurate, and compact.",
    handoffRules: [
      "You are an internal maintenance role. Do not address the user directly.",
      "Keep durable memory accurate, deduplicated, and compact.",
      "Do not perform broad code changes unless explicitly routed elsewhere.",
    ],
    responseContract: [
      "Return concise summaries of memory or context maintenance work performed.",
    ],
  },
  router: {
    id: "router",
    name: "Router",
    description: "Fast request classification and role selection.",
    userFacing: false,
    canChatWithUser: false,
    internalOnly: true,
    maxToolRounds: 0,
    allowedTools: [],
    delegationTargets: ["default", "planner", "coder", "auditor", "maintenance"],
    systemPromptPrefix:
      "You are Ember's Router role. Pick the correct internal role and do not answer the user request directly.",
    handoffRules: [
      "You classify the request and pick the most appropriate internal role.",
      "Do not answer the request itself.",
    ],
    responseContract: [
      "Respond with short structured routing decisions only.",
    ],
  },
};

export const AGENT_ROLES = ROLE_DEFINITIONS;

export function getRole(roleId) {
  return AGENT_ROLES[roleId] || AGENT_ROLES.default;
}

export function canRoleUseTool(roleId, toolName) {
  const role = getRole(roleId);
  return new Set(role.allowedTools || []).has(String(toolName || "").trim());
}

export function canRoleDelegate(fromRoleId, toRoleId) {
  if (!toRoleId) return false;
  const role = getRole(fromRoleId);
  return new Set(role.delegationTargets || []).has(String(toRoleId || "").trim());
}

export function getRoleDelegationTargets(roleId) {
  return [...(getRole(roleId).delegationTargets || [])];
}

export function buildRoleContractPrompt(roleId) {
  const role = getRole(roleId);
  const lines = [
    `[Role contract]`,
    `role_id: ${role.id}`,
    `role_name: ${role.name}`,
    `user_facing: ${role.canChatWithUser ? "yes" : "no"}`,
    `internal_only: ${role.internalOnly ? "yes" : "no"}`,
    `allowed_tools: ${(role.allowedTools || []).join(", ") || "none"}`,
    `delegation_targets: ${(role.delegationTargets || []).join(", ") || "none"}`,
  ];
  if (Array.isArray(role.handoffRules) && role.handoffRules.length > 0) {
    lines.push("", "[Role rules]");
    for (const rule of role.handoffRules) {
      lines.push(`- ${rule}`);
    }
  }
  if (Array.isArray(role.responseContract) && role.responseContract.length > 0) {
    lines.push("", "[Response contract]");
    for (const rule of role.responseContract) {
      lines.push(`- ${rule}`);
    }
  }
  return lines.join("\n");
}

export function filterToolsForRole(toolDefinitions, roleId) {
  return (Array.isArray(toolDefinitions) ? toolDefinitions : []).filter((tool) => {
    const name = tool?.function?.name || tool?.name || "";
    return canRoleUseTool(roleId, name);
  });
}
