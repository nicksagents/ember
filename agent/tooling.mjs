import { readFile, stat, readdir, mkdir, writeFile, rm, rename, copyFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function resolvePath(value) {
  if (!value) return "";
  try {
    return path.resolve(String(value));
  } catch {
    return String(value || "");
  }
}

function normalizePathInput(value, policy) {
  if (!value) return "";
  let text = String(value).trim();
  if (!text) return "";

  const homeDir = policy?.homeDir || os.homedir();
  const workspaceRoot = policy?.workspaceRoot || process.cwd();
  const desktopDir =
    policy?.desktopDir || path.join(homeDir, "Desktop");

  if (text === "." || text === "./") {
    return workspaceRoot;
  }

  if (text.startsWith("~")) {
    text = path.join(homeDir, text.slice(1));
  }

  if (text.startsWith("/Users/")) {
    const parts = text.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.slice(2).join("/");
      text = path.join(homeDir, tail);
    }
  }

  if (text.startsWith("/home/")) {
    const parts = text.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts.slice(2).join("/");
      text = path.join(homeDir, tail);
    }
  }

  const lower = text.toLowerCase();
  if (lower === "desktop" || lower === "desktop/") {
    text = desktopDir;
  } else if (lower.startsWith("desktop/")) {
    text = path.join(desktopDir, text.slice("desktop/".length));
  }

  if (!path.isAbsolute(text) && !/^[a-zA-Z]:[\\/]/.test(text)) {
    text = path.join(workspaceRoot, text);
  }

  return text;
}

function normalizeServerCommand(command) {
  let nextCommand = String(command || "").trim();
  const lower = nextCommand.toLowerCase();
  const isServerStart =
    lower.includes("npm run dev") ||
    lower.includes("npm run start") ||
    lower.includes("pnpm dev") ||
    lower.includes("pnpm start") ||
    lower.includes("yarn dev") ||
    lower.includes("yarn start") ||
    lower.includes("next dev");
  if (!isServerStart) {
    return { command: nextCommand, isServerStart: false };
  }

  if (!/(\bhost\b|--hostname|-H)\s+/.test(nextCommand) && !/\bHOST=/.test(nextCommand)) {
    if (/\bnext dev\b/.test(lower)) {
      nextCommand += " --hostname 0.0.0.0";
    } else {
      nextCommand += " -- --hostname 0.0.0.0";
    }
  }
  if (!/(\bport\b|--port|-p)\s+/.test(nextCommand) && !/\bPORT=/.test(nextCommand)) {
    if (/\bnext dev\b/.test(lower)) {
      nextCommand += " --port 3000";
    } else {
      nextCommand += " -- --port 3000";
    }
  }

  nextCommand = nextCommand.replace(/\bHOST=127\.0\.0\.1\b/g, "HOST=0.0.0.0");
  nextCommand = nextCommand.replace(/\bHOST=localhost\b/g, "HOST=0.0.0.0");
  nextCommand = nextCommand.replace(/--hostname\s+127\.0\.0\.1/g, "--hostname 0.0.0.0");
  nextCommand = nextCommand.replace(/--hostname\s+localhost/g, "--hostname 0.0.0.0");

  return { command: nextCommand, isServerStart: true };
}

async function runSpawnCapture(bin, args = [], options = {}) {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const resolveOnce = (result) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...(options.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolveOnce({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "spawn failed",
      });
      return;
    }

    const timeoutMs = clampNumber(options.timeoutMs, 500, 120000, 10000);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveOnce({
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : "spawn failed"}`,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveOnce({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function uniqueNumbers(values) {
  return Array.from(
    new Set(
      values
        .map((value) => Number.parseInt(String(value || "").trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
}

async function findListeningPids(port) {
  const safePort = clampNumber(Number(port), 1, 65535, 0);
  if (!safePort) return [];

  const lsof = await runSpawnCapture("lsof", ["-tiTCP:" + safePort, "-sTCP:LISTEN"]);
  let pids = uniqueNumbers(lsof.stdout.split(/\s+/));
  if (pids.length > 0) return pids;

  const fuser = await runSpawnCapture("fuser", [`${safePort}/tcp`]);
  pids = uniqueNumbers(`${fuser.stdout} ${fuser.stderr}`.split(/\s+/));
  if (pids.length > 0) return pids;

  const ss = await runSpawnCapture("ss", ["-ltnp", `( sport = :${safePort} )`]);
  const matches = Array.from(
    `${ss.stdout}\n${ss.stderr}`.matchAll(/pid=(\d+)/g),
    (match) => match[1]
  );
  return uniqueNumbers(matches);
}

async function describeProcess(pid) {
  const result = await runSpawnCapture("ps", ["-p", String(pid), "-o", "pid=,ppid=,stat=,etime=,command="]);
  const line = result.stdout.trim().split("\n").filter(Boolean)[0] || "";
  if (!line) {
    return { pid, ppid: null, stat: "", etime: "", command: "" };
  }
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) {
    return { pid, ppid: null, stat: "", etime: "", command: line.trim() };
  }
  return {
    pid: Number.parseInt(match[1], 10),
    ppid: Number.parseInt(match[2], 10),
    stat: match[3],
    etime: match[4],
    command: match[5].trim(),
  };
}

async function listProcesses({ match = "", port = null, limit = 20 } = {}) {
  let rows = [];
  if (port) {
    const pids = await findListeningPids(port);
    rows = await Promise.all(pids.map((pid) => describeProcess(pid)));
  } else {
    const result = await runSpawnCapture("ps", ["-eo", "pid=,ppid=,stat=,etime=,command="], {
      timeoutMs: 10000,
    });
    rows = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/);
        if (!parsed) return null;
        return {
          pid: Number.parseInt(parsed[1], 10),
          ppid: Number.parseInt(parsed[2], 10),
          stat: parsed[3],
          etime: parsed[4],
          command: parsed[5].trim(),
        };
      })
      .filter(Boolean);
  }

  const matchText = String(match || "").trim().toLowerCase();
  if (matchText) {
    rows = rows.filter((row) => row.command.toLowerCase().includes(matchText));
  }
  return rows.slice(0, clampNumber(Number(limit), 1, 200, 20));
}

async function killPidOrGroup(pid, signal = "SIGTERM") {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return true;
    }
  } catch {}
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isUnderPath(candidate, root) {
  if (!candidate || !root) return false;
  const rel = path.relative(root, candidate);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isUnderOrEqual(candidate, root) {
  if (!candidate || !root) return false;
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createFsPolicy({
  homeDir = os.homedir(),
  emberRoots = [],
  allowWriteToEmber = false,
  blockEmberByName = true,
  unrestrictedShell = false,
  workspaceRoot = "",
  desktopDir = "",
  protectedPathsWrite = [],
  protectedPathsDelete = [],
  protectedCommandPatterns = [],
} = {}) {
  const resolvedHome = resolvePath(homeDir);
  const resolvedEmberRoots = Array.isArray(emberRoots)
    ? emberRoots.map((root) => resolvePath(root)).filter(Boolean)
    : [];
  const resolvedWorkspaceRoot = resolvePath(workspaceRoot) || resolvedHome;
  const resolvedDesktopDir = resolvePath(desktopDir) || path.join(resolvedHome, "Desktop");
  const resolvedProtectedWrite = Array.isArray(protectedPathsWrite)
    ? protectedPathsWrite.map((p) => resolvePath(p)).filter(Boolean)
    : [];
  const resolvedProtectedDelete = Array.isArray(protectedPathsDelete)
    ? protectedPathsDelete.map((p) => resolvePath(p)).filter(Boolean)
    : [];
  const resolvedCommandPatterns = Array.isArray(protectedCommandPatterns)
    ? protectedCommandPatterns.map((p) => String(p).toLowerCase()).filter(Boolean)
    : [];

  const isUnderHome = (target) => isUnderPath(resolvePath(target), resolvedHome);
  const isUnderEmber = (target) => {
    const resolved = resolvePath(target);
    if (resolvedEmberRoots.some((root) => isUnderPath(resolved, root))) return true;
    if (!blockEmberByName) return false;
    const parts = resolved.split(path.sep).filter(Boolean);
    return parts.includes("ember");
  };

  const isProtectedWrite = (target) =>
    resolvedProtectedWrite.some((root) => isUnderOrEqual(resolvePath(target), root));
  const isProtectedDelete = (target) =>
    resolvedProtectedDelete.some((root) => isUnderOrEqual(resolvePath(target), root));

  const canWritePath = (target) =>
    !(isUnderEmber(target) && !allowWriteToEmber) && !isProtectedWrite(target);

  const canDeletePath = (target) =>
    !(isUnderEmber(target) && !allowWriteToEmber) && !isProtectedDelete(target);

  return {
    homeDir: resolvedHome,
    emberRoots: resolvedEmberRoots,
    allowWriteToEmber,
    unrestrictedShell: Boolean(unrestrictedShell),
    workspaceRoot: resolvedWorkspaceRoot,
    desktopDir: resolvedDesktopDir,
    protectedPathsWrite: resolvedProtectedWrite,
    protectedPathsDelete: resolvedProtectedDelete,
    protectedCommandPatterns: resolvedCommandPatterns,
    isUnderHome,
    isUnderEmber,
    canWritePath,
    canDeletePath,
  };
}

function buildPolicyError(reason, pathValue) {
  return {
    error: "Policy violation",
    reason,
    path: pathValue,
  };
}

function guardWrite(policy, targetPath) {
  if (!policy) return null;
  if (!policy.canWritePath(targetPath)) {
    const reason = "Writes to protected paths are blocked";
    return buildPolicyError(reason, targetPath);
  }
  return null;
}

function guardDelete(policy, targetPath) {
  if (!policy) return null;
  if (!policy.canDeletePath(targetPath)) {
    const reason = "Deletes of protected paths are blocked";
    return buildPolicyError(reason, targetPath);
  }
  return null;
}

function looksLikeWriteCommand(command) {
  const token = command.toLowerCase();
  return (
    token.includes(" rm ") ||
    token.includes(" rm\t") ||
    token.includes(" mv ") ||
    token.includes(" mv\t") ||
    token.includes(" cp ") ||
    token.includes(" cp\t") ||
    token.includes(" mkdir ") ||
    token.includes(" rmdir ") ||
    token.includes(" touch ") ||
    token.includes(" >") ||
    token.includes(">>") ||
    token.includes(" sed -i") ||
    token.includes(" perl -i") ||
    token.includes(" truncate ")
  );
}

function guardCommand(policy, command) {
  if (!policy || !command) return null;
  if (policy.unrestrictedShell === true) return null;
  const lower = String(command).toLowerCase();
  if (!looksLikeWriteCommand(lower)) return null;
  const roots = [
    ...(policy.protectedPathsWrite || []),
    ...(policy.protectedPathsDelete || []),
  ];
  for (const root of roots) {
    if (root && lower.includes(root.toLowerCase())) {
      return buildPolicyError("Command targets protected path", root);
    }
  }
  for (const pattern of policy.protectedCommandPatterns || []) {
    if (pattern && lower.includes(pattern)) {
      return buildPolicyError("Command targets protected path", pattern);
    }
  }
  return null;
}

async function tryReadFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function walkDir(basePath, options) {
  const entries = [];
  const maxDepth = clampNumber(options.maxDepth, 0, 10, 2);
  const includeHidden = options.includeHidden === true;

  async function walk(dirPath, depth) {
    if (depth > maxDepth) return;
    const items = await readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (!includeHidden && item.name.startsWith(".")) continue;
      const fullPath = path.join(dirPath, item.name);
      entries.push({
        name: item.name,
        path: fullPath,
        type: item.isDirectory() ? "dir" : item.isFile() ? "file" : "other",
      });
      if (item.isDirectory() && options.recursive) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(basePath, 0);
  return entries;
}

export class ToolRegistry {
  constructor({ skillDirs = [] } = {}) {
    this.tools = new Map();
    this.skillDirs = skillDirs;
    this.skillCache = new Map();
  }

  setSkillDirs(skillDirs) {
    this.skillDirs = Array.isArray(skillDirs) ? skillDirs : [];
    this.skillCache.clear();
  }

  register({ name, description, parameters, handler, keywords = [], skillFile }) {
    this.tools.set(name, {
      name,
      description,
      parameters,
      handler,
      keywords: Array.isArray(keywords) ? keywords : [],
      skillFile: skillFile || `${name}.md`,
    });
  }

  list() {
    return Array.from(this.tools.values());
  }

  getDefinitions() {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(name, args) {
    const tool = this.tools.get(name);
    if (!tool) return { error: `Unknown tool: ${name}. Available tools: ${[...this.tools.keys()].join(", ")}` };
    try {
      return await tool.handler(args || {});
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Tool execution failed";
      const code = error?.code || "";
      // Provide actionable hints for common errors
      let hint = "";
      if (code === "ENOENT") hint = " The path does not exist. Check the path and try again.";
      else if (code === "EACCES" || code === "EPERM") hint = " Permission denied. Try a different path.";
      else if (code === "EISDIR") hint = " Target is a directory. Use recursive: true to delete directories.";
      else if (code === "ENOTEMPTY") hint = " Directory is not empty. Use recursive: true.";
      return { error: `${msg}${hint}`, tool: name };
    }
  }

  async getSkill(name) {
    if (this.skillCache.has(name)) return this.skillCache.get(name);
    const tool = this.tools.get(name);
    if (!tool) return "";
    const candidates = this.skillDirs.map((dir) =>
      dir ? path.join(dir, tool.skillFile) : ""
    );
    for (const filePath of candidates) {
      if (!filePath) continue;
      const content = await tryReadFile(filePath);
      if (content.trim()) {
        this.skillCache.set(name, content.trim());
        return content.trim();
      }
    }
    this.skillCache.set(name, "");
    return "";
  }

  buildToolGuide(userContent, maxTools = 4) {
    const tokens = tokenize(userContent);
    if (tokens.length === 0) return "";

    const scored = this.list()
      .map((tool) => {
        let score = 0;
        const haystack = `${tool.name} ${tool.description}`.toLowerCase();
        for (const token of tokens) {
          if (haystack.includes(token)) score += 1.2;
          if (tool.keywords.some((kw) => kw.toLowerCase().includes(token))) {
            score += 2;
          }
        }
        return { tool, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTools);

    if (scored.length === 0) return "";
    const lines = scored.map(
      (entry) => `- ${entry.tool.name}: ${entry.tool.description}`
    );
    return [`[Tool guide]`, "Consider these tools:", ...lines].join("\n");
  }
}

export async function loadToolPlugins(registry, pluginDirs = []) {
  const dirs = Array.isArray(pluginDirs) ? pluginDirs : [];
  for (const dir of dirs) {
    if (!dir) continue;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mjs")) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const mod = await import(fullPath);
        const registerFn = mod?.registerTools || mod?.default;
        if (typeof registerFn === "function") {
          await registerFn(registry);
        }
      } catch {
        // Ignore plugin load failures to keep runtime resilient.
      }
    }
  }
}

export function registerFilesystemTools(registry, { policy } = {}) {
  registry.register({
    name: "list_processes",
    description: "List running processes. Filter by port or a command substring when managing local apps and dev servers.",
    parameters: {
      type: "object",
      properties: {
        port: { type: "number", description: "Listening TCP port to inspect" },
        match: { type: "string", description: "Case-insensitive substring to match in the command" },
        limit: { type: "number", description: "Maximum processes to return" },
      },
      required: [],
    },
    keywords: ["process", "ps", "port", "running", "server"],
    handler: async (args) => {
      const port = Number.isFinite(args?.port) ? args.port : null;
      const processes = await listProcesses({
        port,
        match: args?.match,
        limit: args?.limit,
      });
      return { processes, count: processes.length, port: port || null, match: args?.match || "" };
    },
  });

  registry.register({
    name: "kill_process",
    description: "Stop a running process by pid or by listening port. Use this before restarting a local app or clearing stale dev servers.",
    parameters: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process id to stop" },
        port: { type: "number", description: "Kill the process listening on this TCP port" },
        force: { type: "boolean", description: "Use SIGKILL instead of SIGTERM" },
      },
      required: [],
    },
    keywords: ["kill", "stop", "terminate", "port", "process"],
    handler: async (args) => {
      const pids = [];
      if (Number.isFinite(args?.pid)) {
        pids.push(Number(args.pid));
      }
      if (Number.isFinite(args?.port)) {
        pids.push(...(await findListeningPids(args.port)));
      }
      const uniquePids = uniqueNumbers(pids);
      if (uniquePids.length === 0) {
        return { killed: false, reason: "No matching process found", pid: args?.pid || null, port: args?.port || null };
      }
      const signal = args?.force ? "SIGKILL" : "SIGTERM";
      const results = [];
      for (const pid of uniquePids) {
        const ok = await killPidOrGroup(pid, signal);
        results.push({ pid, signal, ok });
      }
      return {
        killed: results.some((item) => item.ok),
        signal,
        targets: results,
        port: Number.isFinite(args?.port) ? args.port : null,
      };
    },
  });

  registry.register({
    name: "start_dev_server",
    description: "Start a local development server in the background with a target host and port. Use this instead of raw shell for npm/pnpm/yarn dev servers.",
    parameters: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project directory" },
        command: { type: "string", description: "Dev server command (default: npm run dev)" },
        host: { type: "string", description: "Host to bind (default: 0.0.0.0)" },
        port: { type: "number", description: "Port to bind (default: 3000)" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Additional environment variables",
        },
      },
      required: ["cwd"],
    },
    keywords: ["start", "server", "dev", "host", "port", "next"],
    handler: async (args) => {
      const cwd = normalizePathInput(args.cwd, policy);
      const host = String(args.host || "0.0.0.0").trim() || "0.0.0.0";
      const port = clampNumber(Number(args.port), 1, 65535, 3000);
      const baseCommand = String(args.command || "npm run dev").trim() || "npm run dev";
      const normalized = normalizeServerCommand(`HOST=${host} PORT=${port} ${baseCommand}`);
      try {
        const child = spawn("/bin/bash", ["-lc", normalized.command], {
          cwd,
          env: { ...process.env, HOST: host, PORT: String(port), ...(args.env || {}) },
          stdio: "ignore",
          detached: true,
        });
        child.unref();
        return {
          started: true,
          pid: child.pid || null,
          cwd,
          host,
          port,
          command: normalized.command,
        };
      } catch (error) {
        return {
          started: false,
          cwd,
          host,
          port,
          command: normalized.command,
          error: error instanceof Error ? error.message : "Failed to start dev server",
        };
      }
    },
  });

  registry.register({
    name: "verify_server",
    description: "Verify that a local server is listening and responding on a host and port. Use after starting or restarting a project server.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host to probe (0.0.0.0 will be probed via 127.0.0.1)" },
        port: { type: "number", description: "Port to probe" },
        path: { type: "string", description: "HTTP path to request" },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds" },
      },
      required: ["port"],
    },
    keywords: ["verify", "server", "http", "port", "listen", "health"],
    handler: async (args) => {
      const host = String(args.host || "127.0.0.1").trim() || "127.0.0.1";
      const port = clampNumber(Number(args.port), 1, 65535, 3000);
      const pathName = String(args.path || "/").trim() || "/";
      const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
      const listeningPids = await findListeningPids(port);
      const timeoutMs = clampNumber(Number(args.timeoutMs), 500, 30000, 5000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`http://${probeHost}:${port}${pathName}`, {
          method: "GET",
          signal: controller.signal,
        });
        clearTimeout(timer);
        return {
          ok: response.status < 500,
          host,
          probeHost,
          port,
          path: pathName,
          status: response.status,
          listening: listeningPids.length > 0,
          pids: listeningPids,
        };
      } catch (error) {
        clearTimeout(timer);
        return {
          ok: false,
          host,
          probeHost,
          port,
          path: pathName,
          listening: listeningPids.length > 0,
          pids: listeningPids,
          error: error instanceof Error ? error.message : "Server verification failed",
        };
      }
    },
  });

  registry.register({
    name: "list_dir",
    description: "List files and folders in a directory. Set recursive=true to walk subdirectories (max depth 10). Set includeHidden=true for dotfiles.",
    parameters: {
      type: "object",
      properties: {
      path: { type: "string", description: "Directory path" },
        recursive: { type: "boolean", description: "Recursively walk directories" },
        maxDepth: { type: "number", description: "Max recursion depth (0-10)" },
        includeHidden: { type: "boolean", description: "Include dotfiles" },
      },
      required: ["path"],
    },
    keywords: ["list", "directory", "folder", "files", "tree"],
    handler: async (args) => {
      const target = normalizePathInput(args.path || ".", policy);
      const entries = await walkDir(target, {
        recursive: args.recursive === true,
        maxDepth: args.maxDepth,
        includeHidden: args.includeHidden === true,
      });
      return { path: target, entries };
    },
  });

  registry.register({
    name: "read_file",
    description: "Read a text file and return its contents. Optionally read a byte range with start and length parameters.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        start: { type: "number", description: "Byte offset" },
        length: { type: "number", description: "Byte length" },
      },
      required: ["path"],
    },
    keywords: ["read", "file", "open", "view", "cat"],
    handler: async (args) => {
      const filePath = normalizePathInput(args.path, policy);
      const start = clampNumber(args.start, 0, Number.MAX_SAFE_INTEGER, 0);
      const length = clampNumber(args.length, 0, Number.MAX_SAFE_INTEGER, null);
      const data = await readFile(filePath);
      const slice = length === null ? data.slice(start) : data.slice(start, start + length);
      return { path: filePath, content: slice.toString("utf8") };
    },
  });

  registry.register({
    name: "write_file",
    description: "Write text to a file. Set append=true to add to end instead of overwriting. Set createDirs=true to auto-create parent directories.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "UTF-8 text content" },
        append: { type: "boolean", description: "Append instead of overwrite" },
        createDirs: { type: "boolean", description: "Create parent directories" },
      },
      required: ["path", "content"],
    },
    keywords: ["write", "file", "save", "create", "update"],
    handler: async (args) => {
      const filePath = normalizePathInput(args.path, policy);
      const violation = guardWrite(policy, filePath);
      if (violation) return violation;
      if (args.createDirs) {
        await mkdir(path.dirname(filePath), { recursive: true });
      }
      const flag = args.append ? "a" : "w";
      await writeFile(filePath, String(args.content ?? ""), { encoding: "utf8", flag });
      return { path: filePath, bytesWritten: Buffer.byteLength(String(args.content ?? "")) };
    },
  });

  registry.register({
    name: "stat_path",
    description: "Get metadata (size, type, timestamps) for a file or directory. Use this to check if a path exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target path" },
      },
      required: ["path"],
    },
    keywords: ["stat", "metadata", "exists", "size", "mtime"],
    handler: async (args) => {
      const targetPath = normalizePathInput(args.path, policy);
      const info = await stat(targetPath);
      return {
        path: targetPath,
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        size: info.size,
        mtime: info.mtime?.toISOString?.() || null,
        ctime: info.ctime?.toISOString?.() || null,
      };
    },
  });

  registry.register({
    name: "remove_path",
    description: "Delete a file or directory. Directories are automatically deleted recursively. Set force=true to ignore missing paths.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target path" },
        recursive: { type: "boolean", description: "Remove directories recursively" },
        force: { type: "boolean", description: "Ignore missing paths" },
      },
      required: ["path"],
    },
    keywords: ["delete", "remove", "rm", "unlink"],
    handler: async (args) => {
      const targetPath = normalizePathInput(args.path, policy);
      const violation = guardDelete(policy, targetPath);
      if (violation) return violation;
      // Auto-detect directories and default to recursive removal
      let useRecursive = args.recursive === true;
      if (!useRecursive) {
        try {
          const info = await stat(targetPath);
          if (info.isDirectory()) useRecursive = true;
        } catch {
          // Path doesn't exist or can't be stat'd; let rm handle the error
        }
      }
      await rm(targetPath, { recursive: useRecursive, force: args.force === true });
      return { removed: true, path: targetPath };
    },
  });

  registry.register({
    name: "move_path",
    description: "Move or rename a file or directory. Requires from (source) and to (destination) paths. Set overwrite=true to replace existing destination.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source path" },
        to: { type: "string", description: "Destination path" },
        overwrite: { type: "boolean", description: "Overwrite destination if exists" },
      },
      required: ["from", "to"],
    },
    keywords: ["move", "rename", "mv"],
    handler: async (args) => {
      const fromPath = normalizePathInput(args.from, policy);
      const toPath = normalizePathInput(args.to, policy);
      const fromViolation = guardDelete(policy, fromPath);
      if (fromViolation) return fromViolation;
      const toViolation = guardWrite(policy, toPath);
      if (toViolation) return toViolation;
      if (args.overwrite) {
        await rm(toPath, { recursive: true, force: true });
      }
      await rename(fromPath, toPath);
      return { moved: true, from: fromPath, to: toPath };
    },
  });

  registry.register({
    name: "copy_path",
    description: "Copy a file or directory. Set recursive=true for directories. Requires from (source) and to (destination) paths.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source path" },
        to: { type: "string", description: "Destination path" },
        recursive: { type: "boolean", description: "Copy directories recursively" },
        overwrite: { type: "boolean", description: "Overwrite destination if exists" },
      },
      required: ["from", "to"],
    },
    keywords: ["copy", "duplicate", "cp"],
    handler: async (args) => {
      const fromPath = normalizePathInput(args.from, policy);
      const toPath = normalizePathInput(args.to, policy);
      const toViolation = guardWrite(policy, toPath);
      if (toViolation) return toViolation;
      if (args.overwrite) {
        await rm(toPath, { recursive: true, force: true });
      }
      if (args.recursive) {
        await cp(fromPath, toPath, { recursive: true });
        return { copied: true, from: fromPath, to: toPath };
      }
      await copyFile(fromPath, toPath);
      return { copied: true, from: fromPath, to: toPath };
    },
  });

  registry.register({
    name: "run_command",
    description: "Run a bash shell command and return stdout/stderr. Default timeout 30s, max 300s via timeoutMs. Set cwd for working directory. Use background=true for long-running processes.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command string" },
        cwd: { type: "string", description: "Working directory" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        background: {
          type: "boolean",
          description: "Run in detached background mode and return immediately",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment variables",
        },
      },
      required: ["command"],
    },
    keywords: ["run", "command", "shell", "exec", "build", "test"],
    handler: async (args) => {
      let command = String(args.command || "").trim();
      if (!command) return { error: "command is required" };

      // Normalize macOS-style /Users/xxx/ paths to actual home directory
      const homeDir = os.homedir();
      command = command.replace(/\/Users\/[^/\s"']+/g, (match) => {
        const parts = match.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return homeDir;
        }
        return match;
      });
      command = command.replace(/\/home\/[^/\s"']+/g, (match) => {
        const parts = match.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return homeDir;
        }
        return match;
      });
      // Also normalize ~ to home directory for unquoted paths
      command = command.replace(/(^|\s)~\//g, `$1${homeDir}/`);

      const normalizedServer = normalizeServerCommand(command);
      command = normalizedServer.command;

      const violation = guardCommand(policy, command);
      if (violation) return violation;

      const timeoutMs = clampNumber(args.timeoutMs, 1000, 300000, 30000);
      const cwd = args.cwd || policy?.workspaceRoot || process.cwd();
      const env = { ...process.env, ...(args.env || {}) };
      const isBackground = args.background === true || normalizedServer.isServerStart;

      if (isBackground) {
        try {
          const child = spawn("/bin/bash", ["-lc", command], {
            cwd,
            env,
            stdio: "ignore",
            detached: true,
          });
          child.unref();
          return {
            command,
            cwd,
            background: true,
            autoBackground: args.background !== true && normalizedServer.isServerStart,
            started: true,
            pid: child.pid || null,
          };
        } catch (error) {
          return {
            command,
            background: true,
            started: false,
            error: error instanceof Error ? error.message : "Failed to start background command",
          };
        }
      }

      return await new Promise((resolve) => {
        let resolved = false;
        let timedOut = false;
        const resolveOnce = (result) => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };

        const child = spawn("/bin/bash", ["-lc", command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        let stdout = "";
        let stderr = "";
        const MAX_OUTPUT_CHARS = 120000;

        const trimBuffered = (text) =>
          text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;

        const timer = setTimeout(() => {
          timedOut = true;
          if (typeof child.pid === "number" && child.pid > 0 && process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {}
            setTimeout(() => {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {}
            }, 3000).unref();
            return;
          }
          try {
            child.kill("SIGTERM");
          } catch {}
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout = trimBuffered(stdout + String(chunk));
        });
        child.stderr.on("data", (chunk) => {
          stderr = trimBuffered(stderr + String(chunk));
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          resolveOnce({
            command,
            cwd,
            exitCode: null,
            signal: null,
            timedOut,
            timeoutMs,
            stdout,
            stderr,
            error: error instanceof Error ? error.message : "Command execution failed",
          });
        });
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolveOnce({
            command,
            cwd,
            exitCode: code,
            signal: signal || null,
            timedOut,
            timeoutMs,
            stdout,
            stderr,
          });
        });
      });
    },
  });
}

export function formatToolSkillSection(skillsByTool) {
  const blocks = Object.entries(skillsByTool)
    .filter(([, content]) => content)
    .map(([name, content]) => `[Tool skill: ${name}]\n${content}`);
  if (blocks.length === 0) return "";
  return blocks.join("\n\n");
}
