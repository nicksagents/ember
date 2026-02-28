export const LOCAL_IP_COMMAND =
  "hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || ip -4 addr show scope global | awk '/inet / {print $2}' | cut -d/ -f1";
export const TAILSCALE_IPV4_COMMAND = "tailscale ip -4";
export const HOSTNAME_COMMAND = "hostname";

export function normalizeCommandText(command) {
  return String(command || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesCommandHint(command, hint, options = {}) {
  const commandText = normalizeCommandText(command);
  const hintText = normalizeCommandText(hint);
  if (!commandText || !hintText) return false;
  if (options.exact === true) return commandText === hintText;
  return commandText.includes(hintText);
}

export function classifyLocalMachineInfoTask(userContent) {
  const text = String(userContent || "").toLowerCase();
  const wantsTailscaleIp =
    /\btailscale\b/.test(text) && /\bip(?:v4|v6|\s+address)?\b/.test(text);
  const wantsHostname =
    /\bhostname\b/.test(text) &&
    !/\bchange\b|\bset\b|\brename\b/.test(text);
  const wantsLocalIp =
    /\b(?:local|machine|computer|host|this machine|this computer|this host)\b/.test(
      text
    ) &&
    /\bip(?:\s+address)?\b/.test(text);

  if (!wantsLocalIp && !wantsTailscaleIp && !wantsHostname) {
    return null;
  }

  return {
    wantsLocalIp,
    wantsTailscaleIp,
    wantsHostname,
  };
}

export function buildExecutionPlan({
  userContent,
  toolGuide = "",
  isWebLookup = false,
  processTask = null,
  localMachineTask = null,
  isGitRequest = false,
  isReadOnlyFsRequest = false,
  explicitProjectDir = "",
  recentProjectDir = "",
}) {
  const steps = [];

  if (localMachineTask) {
    if (localMachineTask.wantsLocalIp) {
      steps.push("Check the machine's local IP addresses with a shell command.");
    }
    if (localMachineTask.wantsTailscaleIp) {
      steps.push("Check the machine's Tailscale IPv4 address.");
    }
    if (localMachineTask.wantsHostname) {
      steps.push("Read the current hostname from the machine.");
    }
    steps.push("Return the collected values clearly and note any command failures.");
  } else if (processTask) {
    steps.push("Inspect the current process and port state first.");
    steps.push(
      processTask.intent === "stop"
        ? "Stop the target process cleanly."
        : "Apply the requested server action."
    );
    steps.push("Verify the final port state before answering.");
  } else if (isWebLookup) {
    steps.push("Search the web with a small result set.");
    steps.push("Fetch one page only if the snippets are not enough.");
    steps.push("Answer directly from the gathered results.");
  } else if (isGitRequest) {
    steps.push("Inspect the current repository state first.");
    steps.push("Perform the requested git action with local tools.");
    steps.push("Verify the repo state before answering.");
  } else if (isReadOnlyFsRequest) {
    steps.push("Inspect the relevant local files or directories.");
    steps.push("Read the specific file contents needed for the answer.");
    steps.push("Summarize the findings without guessing.");
  } else {
    const targetDir = explicitProjectDir || recentProjectDir;
    if (targetDir) {
      steps.push(`Inspect the relevant workspace at ${targetDir}.`);
    } else {
      steps.push("Inspect the relevant local state with tools first.");
    }
    steps.push("Perform the requested work with the minimum necessary tools.");
    steps.push("Verify the result before answering.");
  }

  if (steps.length === 0 && String(userContent || "").trim()) {
    steps.push("Inspect the relevant local state with tools first.");
    steps.push("Perform the requested work.");
    steps.push("Verify the result before answering.");
  }

  return {
    steps: steps.slice(0, 4),
    toolGuide: String(toolGuide || "").trim(),
  };
}

export function formatExecutionPlanNote(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter(Boolean) : [];
  if (steps.length === 0) return "";
  const lines = ["[Execution plan]"];
  for (let i = 0; i < steps.length; i += 1) {
    lines.push(`${i + 1}. ${steps[i]}`);
  }
  if (plan?.toolGuide) {
    lines.push("");
    lines.push(plan.toolGuide);
  }
  lines.push("");
  lines.push(
    "Use this plan as a guide. Adapt to tool results, but keep going until the request is complete."
  );
  return lines.join("\n");
}
