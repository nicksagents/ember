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
    description: "Run a bash shell command and return stdout/stderr. Default timeout 30s, max 300s via timeoutMs. Set cwd for working directory.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command string" },
        cwd: { type: "string", description: "Working directory" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds" },
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

      const violation = guardCommand(policy, command);
      if (violation) return violation;

      const timeoutMs = clampNumber(args.timeoutMs, 1000, 300000, 30000);
      return await new Promise((resolve) => {
        const child = spawn("/bin/bash", ["-lc", command], {
          cwd: args.cwd || policy?.workspaceRoot || process.cwd(),
          env: { ...process.env, ...(args.env || {}) },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        const timer = setTimeout(() => {
          child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({
            command,
            exitCode: code,
            signal: signal || null,
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
