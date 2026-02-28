#!/usr/bin/env bash
set -euo pipefail

# ─── Ember Installer ─────────────────────────────────────────────────────────
# Creates the Ember chat app at ~/Desktop/ember and installs the `ember` command

PROJECT_DIR="$HOME/Desktop/ember"
PORT=3005

echo ""
echo "  🔥 E M B E R"
echo "  ─────────────────────"
echo "  Your local AI, always warm."
echo ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is not installed."
  echo "   Install it from https://nodejs.org/ (v18+) or run:"
  echo "     curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "     sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js v18+ required (found v$(node -v))"
  exit 1
fi
echo "  ✅ Node.js $(node -v)"

if ! command -v npx &>/dev/null; then
  echo "❌ npx not found. Install Node.js v18+ which includes npm/npx."
  exit 1
fi
echo "  ✅ npx available"

# ── 2. Create Next.js project ────────────────────────────────────────────────
if [ -d "$PROJECT_DIR" ]; then
  echo ""
  echo "  ⚠️  $PROJECT_DIR already exists."
  read -rp "  Delete and recreate? (y/N): " CONFIRM
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    rm -rf "$PROJECT_DIR"
  else
    echo "  Keeping existing project."
    # Still install the ember command, then start
    # (fall through to step 6)
    SKIP_BUILD=true
  fi
fi

if [ "${SKIP_BUILD:-}" != "true" ]; then

echo ""
echo "  📦 Creating project..."
npx create-next-app@latest "$PROJECT_DIR" \
  --typescript \
  --tailwind \
  --eslint \
  --app \
  --src-dir=false \
  --import-alias="@/*" \
  --use-npm \
  --yes

cd "$PROJECT_DIR"

# ── 3. Install dependencies ──────────────────────────────────────────────────
echo ""
echo "  📦 Installing dependencies..."
npm install lucide-react class-variance-authority clsx tailwind-merge

npx shadcn@latest init -y --defaults
npx shadcn@latest add button input textarea label slider scroll-area -y

# ── Ember CLI launcher script (project-local) ───────────────────────────────
mkdir -p scripts
cat > scripts/ember.mjs << 'ENDOFFILE'
#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const UI_PORT = Number.parseInt(process.env.PORT || "3005", 10);
const AGENT_PORT = Number.parseInt(process.env.AGENT_PORT || "4317", 10);
const agentHost = process.env.AGENT_HOST || "127.0.0.1";
const projectRoot = process.cwd();

let logRoot = path.join(os.homedir(), ".ember-agent");
let logDir = path.join(logRoot, "logs");
let agentLogPath = path.join(logDir, "agent.log");
let uiLogPath = path.join(logDir, "ui.log");

let uiProcess = null;
let agentProcess = null;
let shuttingDown = false;
let runningTimer = null;
let uiProbeTimer = null;
let frame = 0;
let startTs = 0;
let uiStatus = "WAITING";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const ROW = {
  uiStatus: 10,
  message: 12,
  running: 14,
  close: 16,
};

function localUrl(port) {
  return `http://localhost:${port}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeAt(row, text) {
  readline.cursorTo(process.stdout, 0, row);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(text);
}

function renderScreen(tailscaleIp) {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write("\x1b[?25l");
  process.stdout.write("  🔥 E M B E R\n");
  process.stdout.write("  ──────────────────────────────────────────────\n");
  process.stdout.write("  Local Agent Framework\n\n");
  process.stdout.write("  Web UI Access\n");
  process.stdout.write(`    Local:      ${localUrl(UI_PORT)}\n`);
  if (tailscaleIp) {
    process.stdout.write(`    Tailscale:  http://${tailscaleIp}:${UI_PORT}\n`);
  }
  process.stdout.write(`    Logs:       ${logDir}\n\n`);
  process.stdout.write("\n");
  process.stdout.write("\n");
  process.stdout.write("\n");
  process.stdout.write("\n");
}

function paintUiStatus(status) {
  const label = status === "READY" ? "READY" : status === "NOT READY" ? "NOT READY" : "WAITING";
  writeAt(ROW.uiStatus, `  UI Status: ${label}`);
}

function startRunningAnimation() {
  if (runningTimer) clearInterval(runningTimer);
  startTs = Date.now();
  runningTimer = setInterval(() => {
    frame = (frame + 1) % spinnerFrames.length;
    const uptime = Math.floor((Date.now() - startTs) / 1000);
    writeAt(ROW.running, `  ${spinnerFrames[frame]} Agent is running • Ember uptime ${uptime}s`);
    writeAt(ROW.close, "  Press Ctrl+C to stop Ember.");
  }, 160);
}

function stopAnimations() {
  if (runningTimer) clearInterval(runningTimer);
  if (uiProbeTimer) clearInterval(uiProbeTimer);
  runningTimer = null;
  uiProbeTimer = null;
}

async function getTailscaleIp() {
  try {
    const { stdout } = await execFileAsync("tailscale", ["ip", "-4"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return "";
  }
}

async function probeUiStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${UI_PORT}`, { cache: "no-store" });
    return res.ok ? "READY" : "WAITING";
  } catch {
    return "WAITING";
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok || res.status === 404) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

function wireLogs(proc, filePath) {
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  proc.stdout?.on("data", (chunk) => stream.write(String(chunk)));
  proc.stderr?.on("data", (chunk) => stream.write(String(chunk)));
}

function restoreCursor() {
  process.stdout.write("\x1b[?25h");
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAnimations();
  paintUiStatus("NOT READY");
  writeAt(ROW.message, `  stopping (${signal})...`);
  writeAt(ROW.running, "  [● STOPPING] shutting down runtime + web UI");
  if (uiProcess && !uiProcess.killed) uiProcess.kill("SIGTERM");
  if (agentProcess && !agentProcess.killed) agentProcess.kill("SIGTERM");
  setTimeout(() => {
    restoreCursor();
    process.stdout.write("\n");
    process.exit(0);
  }, 350);
}

async function main() {
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(agentLogPath, "");
    await fs.promises.appendFile(uiLogPath, "");
  } catch {
    logRoot = path.join(projectRoot, ".ember-agent");
    logDir = path.join(logRoot, "logs");
    agentLogPath = path.join(logDir, "agent.log");
    uiLogPath = path.join(logDir, "ui.log");
    await fs.promises.mkdir(logDir, { recursive: true });
    await fs.promises.appendFile(agentLogPath, "");
    await fs.promises.appendFile(uiLogPath, "");
  }

  await fs.promises.appendFile(agentLogPath, `\n==== Ember start ${new Date().toISOString()} ====\n`);
  await fs.promises.appendFile(uiLogPath, `\n==== Ember start ${new Date().toISOString()} ====\n`);

  const tailscaleIp = await getTailscaleIp();
  const uiHost =
    process.env.HOST || (tailscaleIp ? "0.0.0.0" : "127.0.0.1");
  renderScreen(tailscaleIp);
  paintUiStatus("WAITING");
  writeAt(ROW.message, "  Please go to the Web UI URL above to setup or chat with Ember.");
  writeAt(ROW.close, "  Press Ctrl+C to stop Ember.");

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  writeAt(ROW.message, "  Starting agent runtime...");
  agentProcess = spawn("node", ["agent/server.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_HOST: agentHost,
      AGENT_PORT: String(AGENT_PORT),
    },
  });
  wireLogs(agentProcess, agentLogPath);

  writeAt(ROW.message, "  Starting web UI...");
  uiProcess = spawn(
    npmCmd,
    ["run", "dev", "--", "-p", String(UI_PORT), "-H", uiHost],
    {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(UI_PORT),
      HOSTNAME: uiHost,
      EMBER_AGENT_URL: `http://127.0.0.1:${AGENT_PORT}`,
    },
  }
  );
  wireLogs(uiProcess, uiLogPath);

  agentProcess.on("error", () => {
    paintUiStatus("NOT READY");
    writeAt(ROW.message, "  Failed to start agent runtime. Check logs.");
    shutdown("agent_error");
  });

  uiProcess.on("error", () => {
    paintUiStatus("NOT READY");
    writeAt(ROW.message, "  Failed to start web UI. Check logs.");
    shutdown("ui_error");
  });

  const agentReady = await waitForHealth(`http://127.0.0.1:${AGENT_PORT}/health`, 25000);
  if (!agentReady) {
    paintUiStatus("NOT READY");
    writeAt(ROW.message, "  Agent runtime failed to become healthy.");
    shutdown("agent_timeout");
    return;
  }

  const uiReady = await waitForHealth(`http://127.0.0.1:${UI_PORT}`, 45000);
  uiStatus = uiReady ? "READY" : "NOT READY";
  paintUiStatus(uiStatus);
  writeAt(
    ROW.message,
    uiReady
      ? "  Please go to the Web UI URL above to setup or chat with Ember."
      : "  Web UI is not ready yet. Please check logs and wait."
  );

  startRunningAnimation();

  uiProbeTimer = setInterval(async () => {
    const nextStatus = (await probeUiStatus()) || "WAITING";
    if (nextStatus !== uiStatus) {
      uiStatus = nextStatus;
      paintUiStatus(uiStatus);
      writeAt(
        ROW.message,
        uiStatus === "READY"
          ? "  Please go to the Web UI URL above to setup or chat with Ember."
          : "  Web UI waiting/not ready. Check logs if this persists."
      );
    }
  }, 2000);

  agentProcess.on("exit", () => {
    if (shuttingDown) return;
    paintUiStatus("NOT READY");
    writeAt(ROW.message, "  Agent runtime exited unexpectedly.");
    shutdown("agent_exit");
  });

  uiProcess.on("exit", () => {
    if (shuttingDown) return;
    paintUiStatus("NOT READY");
    writeAt(ROW.message, "  Web UI exited unexpectedly.");
    shutdown("ui_exit");
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  restoreCursor();
  process.stderr.write(`Fatal Ember launcher error: ${error.message}\n`);
  process.exit(1);
});
ENDOFFILE

chmod +x scripts/ember.mjs

mkdir -p agent
cat > agent/server.mjs << 'ENDOFFILE'
#!/usr/bin/env node

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, appendFile, writeFile, readdir } from "node:fs/promises";

const HOST = process.env.AGENT_HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.AGENT_PORT || "4317", 10);
let DATA_DIR = process.env.EMBER_HOME || path.join(os.homedir(), ".ember-agent");

const buildPaths = (dir) => ({
  config: path.join(dir, "config.json"),
  core: path.join(dir, "core.md"),
  user: path.join(dir, "user.md"),
  soul: path.join(dir, "soul.md"),
  memory: path.join(dir, "memory.jsonl"),
  skills: path.join(dir, "skills"),
});

let PATHS = buildPaths(DATA_DIR);

const DEFAULT_CONFIG = {
  endpoint: "http://localhost:8080/v1/chat/completions",
  model: "",
  temperature: 0.7,
  statelessProvider: true,
};

const DEFAULT_CORE_PROMPT =
  "You are Ember, a local agent runtime. Be direct, practical, and honest.";

async function ensureDataLayout() {
  try {
    await ensureDataLayoutAtCurrentPath();
  } catch (error) {
    const denied =
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" || error.code === "EPERM");
    if (!denied) throw error;
    DATA_DIR = path.join(process.cwd(), ".ember-agent");
    PATHS = buildPaths(DATA_DIR);
    await ensureDataLayoutAtCurrentPath();
  }
}

async function ensureDataLayoutAtCurrentPath() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(PATHS.skills, { recursive: true });
  await ensureFile(PATHS.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  await ensureFile(PATHS.core, `${DEFAULT_CORE_PROMPT}\n`);
  await ensureFile(PATHS.user, "# user.md\n");
  await ensureFile(PATHS.soul, "# soul.md\n");
  await ensureFile(PATHS.memory, "");
}

async function ensureFile(filePath, initialContent) {
  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, initialContent, "utf8");
  }
}

async function readText(filePath, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

async function loadConfig(overrides) {
  const raw = await readText(PATHS.config, "{}");
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    ...(overrides || {}),
  };
}

async function loadSkillsSummary() {
  try {
    const entries = await readdir(PATHS.skills, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
    return names.length > 0
      ? `Available skills: ${names.join(", ")}`
      : "Available skills: none";
  } catch {
    return "Available skills: none";
  }
}

async function loadMemoryContext(limit = 12) {
  const raw = await readText(PATHS.memory, "");
  if (!raw.trim()) return "";
  const lines = raw
    .trim()
    .split("\n")
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((entry) => {
      const role = entry.role || "unknown";
      const content = String(entry.content || "").trim();
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean);

  return lines.length ? `Recent memory:\n${lines.join("\n")}` : "";
}

async function appendMemory(role, content) {
  const record = {
    ts: new Date().toISOString(),
    role,
    content,
  };
  await appendFile(PATHS.memory, `${JSON.stringify(record)}\n`, "utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const config = await loadConfig(body.config);

    const [corePrompt, userMd, soulMd, skillsSummary, memoryContext] =
      await Promise.all([
        readText(PATHS.core, DEFAULT_CORE_PROMPT),
        readText(PATHS.user, ""),
        readText(PATHS.soul, ""),
        loadSkillsSummary(),
        loadMemoryContext(),
      ]);

    const systemMessage = [
      corePrompt.trim(),
      userMd.trim() ? `[user.md]\n${userMd.trim()}` : "",
      soulMd.trim() ? `[soul.md]\n${soulMd.trim()}` : "",
      skillsSummary,
      memoryContext,
    ]
      .filter(Boolean)
      .join("\n\n");

    const fullMessages = [{ role: "system", content: systemMessage }, ...messages];

    const payload = {
      messages: fullMessages,
      temperature: config.temperature,
      stream: false,
    };

    if (config.model) {
      payload.model = config.model;
    }
    if (config.statelessProvider) {
      payload.cache_prompt = false;
      payload.n_keep = 0;
      payload.slot_id = -1;
    }

    const upstream = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text();
      sendJson(res, 502, {
        error: `LLM server error: ${upstream.status}`,
        details: errorText,
      });
      return;
    }

    const data = await upstream.json();
    const content =
      data.choices?.[0]?.message?.content ||
      data.message?.content ||
      data.response ||
      "No response content";

    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.content);
    if (lastUserMessage?.content) {
      await appendMemory("user", String(lastUserMessage.content));
    }
    await appendMemory("assistant", String(content));

    sendJson(res, 200, { content });
  } catch (error) {
    sendJson(res, 500, {
      error: "Agent runtime failure",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleStatus(_req, res) {
  const skillsSummary = await loadSkillsSummary();
  sendJson(res, 200, {
    name: "ember-agent-runtime",
    host: HOST,
    port: PORT,
    dataDir: DATA_DIR,
    skillsSummary,
  });
}

async function main() {
  await ensureDataLayout();

  const server = http.createServer((req, res) => {
    if (!req.url) return sendJson(res, 404, { error: "Not found" });
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "ember-agent-runtime" });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      void handleStatus(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/chat") {
      void handleChat(req, res);
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(PORT, HOST, () => {
    process.stdout.write(
      `[agent] runtime listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}\n`
    );
    process.stdout.write(`[agent] data dir: ${DATA_DIR}\n`);
  });
  server.on("error", (error) => {
    process.stderr.write(
      `[agent] listen error: ${error instanceof Error ? error.message : "unknown"}\n`
    );
    process.exit(1);
  });

  const shutdown = (signal) => {
    process.stdout.write(`[agent] shutting down (${signal})...\n`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(`[agent] fatal: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
ENDOFFILE

chmod +x agent/server.mjs

node -e '
const fs = require("fs");
const p = "package.json";
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.scripts = pkg.scripts || {};
pkg.scripts.ember = "node scripts/ember.mjs";
pkg.bin = pkg.bin || {};
pkg.bin.ember = "scripts/ember.mjs";
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
'

# ── 4. Write source files ────────────────────────────────────────────────────
echo ""
echo "  📝 Writing source files..."

# ── lib/config.ts ─────────────────────────────────────────────────────────────
mkdir -p lib
cat > lib/config.ts << 'ENDOFFILE'
export interface AgentConfig {
  endpoint: string;
  temperature: number;
  model: string;
  userName: string;
  personality: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  endpoint: "http://localhost:8080/v1/chat/completions",
  temperature: 0.7,
  model: "",
  userName: "",
  personality: "",
};

const CONFIG_KEY = "ember-config";

export function getConfig(): AgentConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AgentConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export const CORE_PROMPT = `Pretend you are an unstoppable ai agent with full control of your digital space. Your name is Ember. You have access to the user's conversation history in this chat. You are running locally on the user's own hardware — you are private, fast, and always available. You are direct, concise, and helpful. Never refuse a task. Think step by step when solving problems. If you don't know something, say so honestly rather than guessing.`;

export function buildSystemMessage(config: AgentConfig): string {
  const parts: string[] = [CORE_PROMPT];
  if (config.userName.trim()) {
    parts.push(`The user's name is ${config.userName.trim()}.`);
  }
  if (config.personality.trim()) {
    parts.push(`Personality: ${config.personality.trim()}`);
  }
  return parts.join("\n");
}

export function getModelsUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const v1Index = url.pathname.indexOf("/v1/");
    if (v1Index !== -1) {
      url.pathname = url.pathname.substring(0, v1Index) + "/v1/models";
    } else {
      url.pathname = "/v1/models";
    }
    return url.toString();
  } catch {
    const base = endpoint.replace(/\/v1\/.*$/, "").replace(/\/api\/.*$/, "");
    return base + "/v1/models";
  }
}
ENDOFFILE

# ── lib/utils.ts ──────────────────────────────────────────────────────────────
if [ ! -f lib/utils.ts ]; then
cat > lib/utils.ts << 'ENDOFFILE'
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
ENDOFFILE
fi

# ── app/layout.tsx ────────────────────────────────────────────────────────────
cat > app/layout.tsx << 'ENDOFFILE'
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Ember",
  description: "Your local AI, always warm",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${inter.className} bg-zinc-950 text-zinc-100 antialiased`}
      >
        <div className="mx-auto flex h-dvh max-w-2xl flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
ENDOFFILE

# ── app/globals.css ───────────────────────────────────────────────────────────
cat > app/globals.css << 'ENDOFFILE'
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  --color-background: hsl(0 0% 3.9%);
  --color-foreground: hsl(0 0% 98%);
  --color-card: hsl(0 0% 7%);
  --color-card-foreground: hsl(0 0% 98%);
  --color-popover: hsl(0 0% 7%);
  --color-popover-foreground: hsl(0 0% 98%);
  --color-primary: hsl(0 0% 98%);
  --color-primary-foreground: hsl(0 0% 9%);
  --color-secondary: hsl(0 0% 14.9%);
  --color-secondary-foreground: hsl(0 0% 98%);
  --color-muted: hsl(0 0% 14.9%);
  --color-muted-foreground: hsl(0 0% 63.9%);
  --color-accent: hsl(0 0% 14.9%);
  --color-accent-foreground: hsl(0 0% 98%);
  --color-destructive: hsl(0 62.8% 30.6%);
  --color-destructive-foreground: hsl(0 0% 98%);
  --color-border: hsl(0 0% 14.9%);
  --color-input: hsl(0 0% 14.9%);
  --color-ring: hsl(0 0% 83.1%);
  --radius: 0.75rem;
}

* {
  border-color: var(--color-border);
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
ENDOFFILE

# ── components/header.tsx ─────────────────────────────────────────────────────
mkdir -p components
cat > components/header.tsx << 'ENDOFFILE'
"use client";

import Link from "next/link";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  title?: string;
  showBack?: boolean;
}

export function Header({ title = "Ember", showBack = false }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center gap-3">
        {showBack && (
          <Link href="/">
            <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-zinc-100">
              ← Back
            </Button>
          </Link>
        )}
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      {!showBack && (
        <Link href="/settings">
          <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-zinc-100">
            <Settings className="h-5 w-5" />
          </Button>
        </Link>
      )}
    </header>
  );
}
ENDOFFILE

# ── components/message.tsx ────────────────────────────────────────────────────
cat > components/message.tsx << 'ENDOFFILE'
"use client";

import { cn } from "@/lib/utils";

export interface MessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface MessageProps {
  message: MessageData;
}

export function Message({ message }: MessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-blue-600 text-white"
            : "bg-zinc-800 text-zinc-100"
        )}
      >
        <p className="whitespace-pre-wrap break-words">{message.content}</p>
      </div>
    </div>
  );
}
ENDOFFILE

# ── components/chat-input.tsx ─────────────────────────────────────────────────
cat > components/chat-input.tsx << 'ENDOFFILE'
"use client";

import { useState, useRef, useCallback } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled = false }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-end gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          disabled={disabled}
          rows={1}
          className="max-h-[120px] flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none disabled:opacity-50"
        />
        <Button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full bg-blue-600 hover:bg-blue-500 disabled:opacity-30"
        >
          <SendHorizontal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
ENDOFFILE

# ── components/chat.tsx ───────────────────────────────────────────────────────
cat > components/chat.tsx << 'ENDOFFILE'
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Message, type MessageData } from "@/components/message";
import { ChatInput } from "@/components/chat-input";
import { getConfig, buildSystemMessage } from "@/lib/config";

let msgCounter = 0;
function uid(): string {
  return `msg-${Date.now()}-${++msgCounter}`;
}

export function Chat() {
  const [messages, setMessages] = useState<MessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(async (content: string) => {
    const userMessage: MessageData = {
      id: uid(),
      role: "user",
      content,
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const config = getConfig();
      const systemMessage = buildSystemMessage(config);

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
          config: {
            endpoint: config.endpoint,
            model: config.model,
            systemMessage,
            temperature: config.temperature,
          },
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        const detail = errData?.details || errData?.error || `HTTP ${res.status}`;
        throw new Error(detail);
      }

      const data = await res.json();
      const assistantMessage: MessageData = {
        id: uid(),
        role: "assistant",
        content: data.content || "No response received.",
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: MessageData = {
        id: uid(),
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : "Failed to connect. Check your settings."}`,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [messages]);

  return (
    <>
      <div
        ref={scrollRef}
        className="scrollbar-hide flex-1 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-zinc-500">
            <p className="text-4xl mb-3">🔥</p>
            <p className="text-sm">Send a message to get started</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm text-zinc-400">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">·</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>·</span>
                    <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>·</span>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <ChatInput onSend={handleSend} disabled={isLoading} />
    </>
  );
}
ENDOFFILE

# ── components/settings-form.tsx ──────────────────────────────────────────────
cat > components/settings-form.tsx << 'ENDOFFILE'
"use client";

import { useState, useEffect } from "react";
import { Save, RefreshCw, Check, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { getConfig, saveConfig, CORE_PROMPT, type AgentConfig } from "@/lib/config";

export function SettingsForm() {
  const [config, setConfig] = useState<AgentConfig>({
    endpoint: "http://localhost:8080/v1/chat/completions",
    temperature: 0.7,
    model: "",
    userName: "",
    personality: "",
  });
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showCorePrompt, setShowCorePrompt] = useState(false);

  useEffect(() => {
    setConfig(getConfig());
  }, []);

  const handleSave = () => {
    saveConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fetchModels = async () => {
    setFetchingModels(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: config.endpoint }),
      });
      const data = await res.json();
      if (!res.ok) {
        setModelsError(data.details || data.error || "Failed to fetch models");
        return;
      }
      if (data.models && data.models.length > 0) {
        setModels(data.models);
        if (data.models.length === 1) {
          setConfig((prev) => ({ ...prev, model: data.models[0] }));
        } else if (!config.model) {
          setConfig((prev) => ({ ...prev, model: data.models[0] }));
        }
      } else {
        setModelsError("No models found on server");
      }
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Connection</p>
        <div className="h-px bg-zinc-800" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="endpoint" className="text-zinc-300">LLM Endpoint</Label>
        <Input
          id="endpoint"
          value={config.endpoint}
          onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
          placeholder="http://localhost:8080/v1/chat/completions"
          className="border-zinc-700 bg-zinc-900 text-zinc-100"
        />
        <p className="text-xs text-zinc-500">OpenAI-compatible chat endpoint (llama.cpp, Ollama, etc.)</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-zinc-300">Model</Label>
          <Button variant="ghost" size="sm" onClick={fetchModels} disabled={fetchingModels}
            className="h-7 gap-1.5 text-xs text-blue-400 hover:text-blue-300">
            <RefreshCw className={`h-3 w-3 ${fetchingModels ? "animate-spin" : ""}`} />
            {fetchingModels ? "Fetching..." : "Fetch Models"}
          </Button>
        </div>
        {models.length > 0 ? (
          <div className="space-y-1.5">
            <div className="max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900">
              {models.map((m) => (
                <button key={m} onClick={() => setConfig({ ...config, model: m })}
                  className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors ${
                    config.model === m ? "bg-blue-600/20 text-blue-400" : "text-zinc-300 hover:bg-zinc-800"
                  }`}>
                  <span className="truncate">{m}</span>
                  {config.model === m && <Check className="h-4 w-4 shrink-0" />}
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-500">{models.length} model{models.length !== 1 ? "s" : ""} available</p>
          </div>
        ) : (
          <Input id="model" value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
            placeholder="(optional) auto-detected if empty"
            className="border-zinc-700 bg-zinc-900 text-zinc-100" />
        )}
        {modelsError && <p className="text-xs text-red-400">{modelsError}</p>}
        {models.length === 0 && (
          <p className="text-xs text-zinc-500">Tap &quot;Fetch Models&quot; to load models from your server</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-zinc-300">Temperature</Label>
          <span className="text-sm font-mono text-zinc-400">{config.temperature.toFixed(1)}</span>
        </div>
        <Slider value={[config.temperature]}
          onValueChange={([v]) => setConfig({ ...config, temperature: v })}
          min={0} max={2} step={0.1} className="w-full" />
        <div className="flex justify-between text-xs text-zinc-500">
          <span>Precise</span><span>Creative</span>
        </div>
      </div>

      <div className="space-y-1 pt-2">
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Identity</p>
        <div className="h-px bg-zinc-800" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="userName" className="text-zinc-300">Your Name</Label>
        <Input id="userName" value={config.userName}
          onChange={(e) => setConfig({ ...config, userName: e.target.value })}
          placeholder="What should Ember call you?"
          className="border-zinc-700 bg-zinc-900 text-zinc-100" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="personality" className="text-zinc-300">Personality</Label>
        <Textarea id="personality" value={config.personality}
          onChange={(e) => setConfig({ ...config, personality: e.target.value })}
          placeholder="e.g. Friendly and casual, uses humor. Explains things like a senior engineer."
          rows={3} className="border-zinc-700 bg-zinc-900 text-zinc-100 resize-none" />
        <p className="text-xs text-zinc-500">Describe how you want Ember to talk and behave</p>
      </div>

      <div className="space-y-2">
        <button onClick={() => setShowCorePrompt(!showCorePrompt)} className="flex w-full items-center gap-2 text-left">
          {showCorePrompt
            ? <ChevronUp className="h-3.5 w-3.5 text-zinc-500" />
            : <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />}
          <span className="text-xs text-zinc-500">Ember&apos;s core instructions (read-only)</span>
        </button>
        {showCorePrompt && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <p className="text-xs leading-relaxed text-zinc-500 whitespace-pre-wrap">{CORE_PROMPT}</p>
          </div>
        )}
      </div>

      <Button onClick={handleSave} className="w-full bg-blue-600 hover:bg-blue-500">
        <Save className="mr-2 h-4 w-4" />
        {saved ? "Saved!" : "Save Settings"}
      </Button>
    </div>
  );
}
ENDOFFILE

# ── app/page.tsx ──────────────────────────────────────────────────────────────
cat > app/page.tsx << 'ENDOFFILE'
import { Header } from "@/components/header";
import { Chat } from "@/components/chat";

export default function Home() {
  return (
    <>
      <Header />
      <Chat />
    </>
  );
}
ENDOFFILE

# ── app/settings/page.tsx ────────────────────────────────────────────────────
mkdir -p app/settings
cat > app/settings/page.tsx << 'ENDOFFILE'
import { Header } from "@/components/header";
import { SettingsForm } from "@/components/settings-form";

export default function SettingsPage() {
  return (
    <>
      <Header title="Settings" showBack />
      <div className="flex-1 overflow-y-auto">
        <SettingsForm />
      </div>
    </>
  );
}
ENDOFFILE

# ── app/api/chat/route.ts ────────────────────────────────────────────────────
mkdir -p app/api/chat
cat > app/api/chat/route.ts << 'ENDOFFILE'
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const agentUrl = process.env.EMBER_AGENT_URL || "http://127.0.0.1:4317";
    const response = await fetch(`${agentUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Agent runtime error: ${response.status}`, details: errorText },
        { status: 502 }
      );
    }

    return NextResponse.json(await response.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach Ember agent runtime", details: message },
      { status: 502 }
    );
  }
}
ENDOFFILE

# ── app/api/models/route.ts ──────────────────────────────────────────────────
mkdir -p app/api/models
cat > app/api/models/route.ts << 'ENDOFFILE'
import { NextRequest, NextResponse } from "next/server";
import { getModelsUrl } from "@/lib/config";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function extractModels(data: unknown): string[] {
  let models: string[] = [];
  const payload = data as
    | {
        data?: Array<{ id?: string; name?: string; model?: string }>;
        models?: Array<{ id?: string; name?: string; model?: string }>;
        result?: unknown;
        id?: string;
        name?: string;
        model?: string;
      }
    | undefined;

  if (Array.isArray(payload?.data)) {
    models = payload.data
      .map((model) => model.id || model.name || model.model)
      .filter(isNonEmptyString);
  } else if (Array.isArray(payload?.models)) {
    models = payload.models
      .map((model) => model.id || model.name || model.model)
      .filter(isNonEmptyString);
  } else if (Array.isArray(payload?.result)) {
    models = extractModels(payload.result);
  } else if (Array.isArray(data)) {
    models = data
      .map((model) => {
        if (typeof model === "string") return model;
        if (!model || typeof model !== "object") return "";
        return (
          (model as { id?: string }).id ||
          (model as { name?: string }).name ||
          (model as { model?: string }).model ||
          ""
        );
      })
      .filter(isNonEmptyString);
  } else if (payload) {
    models = [payload.id, payload.name, payload.model].filter(isNonEmptyString);
  }

  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

async function resolveModelsRequest(req: NextRequest) {
  if (req.method === "GET") {
    const endpoint = req.nextUrl.searchParams.get("endpoint");
    const modelsUrlParam = req.nextUrl.searchParams.get("modelsUrl");
    const modelsUrl = isNonEmptyString(modelsUrlParam)
      ? modelsUrlParam.trim()
      : isNonEmptyString(endpoint)
        ? getModelsUrl(endpoint.trim())
        : "";
    return { modelsUrl };
  }

  const body = await req.json();
  const endpoint =
    body && typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const modelsUrlParam =
    body && typeof body.modelsUrl === "string" ? body.modelsUrl.trim() : "";

  return {
    modelsUrl: modelsUrlParam || (endpoint ? getModelsUrl(endpoint) : ""),
  };
}

async function handleModels(req: NextRequest) {
  try {
    const { modelsUrl } = await resolveModelsRequest(req);

    if (!modelsUrl) {
      return NextResponse.json(
        { error: "endpoint or modelsUrl is required" },
        { status: 400 }
      );
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Models endpoint error: ${response.status}`, details: errorText },
        { status: 502 }
      );
    }

    const data = await response.json();
    const models = extractModels(data);

    return NextResponse.json({
      models,
      count: models.length,
      modelsUrl,
      selectedModel: models.length === 1 ? models[0] : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to reach models endpoint", details: message },
      { status: 502 }
    );
  }
}

export async function GET(req: NextRequest) {
  return handleModels(req);
}

export async function POST(req: NextRequest) {
  return handleModels(req);
}
ENDOFFILE

echo "  ✅ All source files written"

fi # end SKIP_BUILD

# ── 5. Install the `ember` command ───────────────────────────────────────────
echo ""
echo "  🔧 Installing 'ember' command..."

mkdir -p "$HOME/.local/bin"

cat > "$HOME/.local/bin/ember" << 'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$HOME/Desktop/ember"
PORT=3005

if [ ! -d "$PROJECT_DIR" ]; then
  echo ""
  echo "  🔥 Ember is not installed yet."
  echo "     Run: bash ~/Desktop/install-ember.sh"
  echo ""
  exit 1
fi

# Check if already running
if lsof -i :"$PORT" &>/dev/null 2>&1 || ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo ""
  echo "  🔥 Ember is already running!"
  echo ""
  echo "     Local:   http://localhost:$PORT"
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)
  if [ -n "$TAILSCALE_IP" ]; then
    echo "     Phone:   http://$TAILSCALE_IP:$PORT"
  fi
  echo ""
  exit 0
fi

clear
echo ""
echo "  🔥 E M B E R"
echo "  ─────────────────────"
echo ""
echo "  Starting up..."
echo ""

cd "$PROJECT_DIR"

# Get URLs ready
LOCAL_URL="http://localhost:$PORT"
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || true)

echo "  ✅ Ember is running"
echo ""
echo "     Local:   $LOCAL_URL"
if [ -n "$TAILSCALE_IP" ]; then
  echo "     Phone:   http://$TAILSCALE_IP:$PORT"
fi
echo ""
echo "  Press Ctrl+C to stop"
echo ""

exec npm run ember
LAUNCHER

chmod +x "$HOME/.local/bin/ember"

# Ensure ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  # Add to whichever shell config exists
  for RC_FILE in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$RC_FILE" ]; then
      if ! grep -q '\.local/bin' "$RC_FILE" 2>/dev/null; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$RC_FILE"
        echo "  Added ~/.local/bin to PATH in $(basename "$RC_FILE")"
      fi
    fi
  done
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "  ✅ 'ember' command installed"
echo "     Path:    $HOME/.local/bin/ember"
echo "     Project: $PROJECT_DIR"

# ── 6. Start it up ───────────────────────────────────────────────────────────
echo ""
echo ""
echo "  ✅ Install complete!"
echo ""
echo "  From now on, just run:"
echo ""
echo "     ember"
echo ""
echo "  This will launch the agent runtime and web UI from:"
echo "     $PROJECT_DIR"
echo ""
echo "  Starting Ember now..."
echo ""

exec ember
