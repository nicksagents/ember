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
  memoryItems = [],
}) {
  const text = String(userContent || "").toLowerCase();
  const steps = [];
  const wantsFileEdit =
    /\b(?:edit|change|modify|update|replace|rewrite|refactor|fix|restyle|redesign)\b/.test(
      text
    ) &&
    (
      /\b(?:file|code|page|component|function|route|config|layout|style|styling|dashboard)\b/.test(
        text
      ) ||
      /\b[a-z0-9._-]+\.(?:tsx|ts|jsx|js|mjs|cjs|json|md|css|scss|html|yml|yaml)\b/.test(
        text
      )
    );
  const wantsDirectoryListingOnly =
    /\b(?:list|show|what'?s?\s+in|whats?\s+in|contents?)\b/.test(text) &&
    /\b(?:desktop|folder|directory|repo|repository|workspace|project|files?)\b/.test(text) &&
    !/\b(?:read|open|view|inspect file|file contents?|inside the file|json|package\.json|config|source code)\b/.test(text);
  const wantsExistenceCheck =
    /\b(?:confirm|check|verify|whether|if there(?:'s| is)|exists?)\b/.test(text);

  if (localMachineTask) {
    if (localMachineTask.wantsLocalIp) {
      steps.push("Check the machine's local IP addresses (run_command).");
    }
    if (localMachineTask.wantsTailscaleIp) {
      steps.push("Check the machine's Tailscale IPv4 address (run_command).");
    }
    if (localMachineTask.wantsHostname) {
      steps.push("Read the current hostname from the machine (run_command).");
    }
    steps.push("Return the collected values clearly and note any command failures.");
  } else if (processTask) {
    steps.push("Inspect the current process and port state first (list_processes).");
    steps.push(
      processTask.intent === "stop"
        ? "Stop the target process cleanly (kill_process)."
        : "Apply the requested server action (start_dev_server)."
    );
    steps.push("Verify the final port state before answering (verify_server).");
  } else if (isWebLookup) {
    steps.push("Search the web with a small result set (web_search).");
    steps.push("Fetch one page only if the snippets are not enough (fetch_url).");
    steps.push("Answer directly from the gathered results.");
  } else if (isGitRequest) {
    steps.push("Inspect the current repository state first (run_command).");
    steps.push("Perform the requested git action with local tools (run_command).");
    steps.push("Verify the repo state before answering (run_command).");
  } else if (isReadOnlyFsRequest) {
    steps.push("Inspect the relevant local files or directories (list_dir).");
    if (wantsDirectoryListingOnly) {
      if (wantsExistenceCheck) {
        steps.push("Confirm whether the requested file or folder is present (stat_path).");
      }
      steps.push("Answer from the directory listing without guessing.");
    } else {
      steps.push("Read the specific file contents needed for the answer (read_file).");
      steps.push("Summarize the findings without guessing.");
    }
  } else {
    const targetDir = explicitProjectDir || recentProjectDir;
    if (targetDir) {
      steps.push(`Inspect the relevant workspace at ${targetDir} (list_dir).`);
      steps.push("Read the files needed before making changes (read_file).");
      if (wantsFileEdit) {
        steps.push("Write the updated file contents to disk (write_file).");
        steps.push("Verify the edited file contents before answering (read_file).");
      } else {
        steps.push("Perform the requested work with the minimum necessary tools.");
        steps.push("Verify the result before answering.");
      }
    } else {
      steps.push(
        wantsFileEdit
          ? "Inspect the relevant local state and target files first (list_dir)."
          : "Inspect the relevant local state with tools first."
      );
      if (wantsFileEdit) {
        steps.push("Read the target file contents before editing (read_file).");
        steps.push("Apply the requested edits to the target files (write_file).");
        steps.push("Verify the edited file contents before answering (read_file).");
      } else {
        steps.push("Perform the requested work with the minimum necessary tools.");
        steps.push("Verify the result before answering.");
      }
    }
  }

  if (steps.length === 0 && String(userContent || "").trim()) {
    steps.push("Inspect the relevant local state with tools first.");
    steps.push("Perform the requested work.");
    steps.push("Verify the result before answering.");
  }

  if (Array.isArray(memoryItems) && memoryItems.length > 0) {
    steps.push("Save the durable memory candidates with save_memory before the final response.");
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
