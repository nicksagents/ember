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
    if (shuttingDown) return false;
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

// Kill a child process and its entire process tree
function killTree(child, signal) {
  if (!child || child.killed) return;
  try {
    // child was spawned with detached: true, so child.pid is the PGID.
    // Negative pid sends signal to the entire process group.
    process.kill(-child.pid, signal);
  } catch {
    // Process group already gone; try the child directly as a fallback.
    try { child.kill(signal); } catch {}
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    // Second Ctrl+C: force-kill everything immediately
    try { killTree(uiProcess, "SIGKILL"); } catch {}
    try { killTree(agentProcess, "SIGKILL"); } catch {}
    restoreCursor();
    process.stdout.write("\n");
    process.exit(1);
  }
  shuttingDown = true;
  stopAnimations();
  paintUiStatus("NOT READY");
  writeAt(ROW.message, `  stopping (${signal})...`);
  writeAt(ROW.running, "  [● STOPPING] shutting down runtime + web UI");

  // Send SIGTERM to both process groups
  killTree(uiProcess, "SIGTERM");
  killTree(agentProcess, "SIGTERM");

  // After 2 seconds, escalate to SIGKILL for any stragglers
  const killTimer = setTimeout(() => {
    killTree(uiProcess, "SIGKILL");
    killTree(agentProcess, "SIGKILL");
  }, 2000);
  killTimer.unref();

  // Hard exit after 3 seconds no matter what
  const exitTimer = setTimeout(() => {
    restoreCursor();
    process.stdout.write("\n");
    process.exit(0);
  }, 3000);
  exitTimer.unref();

  // Track child exits; when both are gone we can exit immediately
  let exited = 0;
  const totalChildren = (uiProcess ? 1 : 0) + (agentProcess ? 1 : 0);
  const onChildExit = () => {
    exited += 1;
    if (exited >= totalChildren) {
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      restoreCursor();
      process.stdout.write("\n");
      process.exit(0);
    }
  };

  if (agentProcess) agentProcess.once("exit", onChildExit);
  if (uiProcess) uiProcess.once("exit", onChildExit);

  // If no children were spawned yet, just exit
  if (totalChildren === 0) {
    clearTimeout(killTimer);
    clearTimeout(exitTimer);
    restoreCursor();
    process.stdout.write("\n");
    process.exit(0);
  }
}

// Register signal handlers EARLY so Ctrl+C works during startup
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Always restore cursor on exit (crash safety)
process.on("exit", restoreCursor);

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
    detached: true,
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
    ["run", "dev", "--", "--webpack", "-p", String(UI_PORT), "-H", uiHost],
    {
    cwd: projectRoot,
    detached: true,
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
}

main().catch((error) => {
  restoreCursor();
  process.stderr.write(`Fatal Ember launcher error: ${error.message}\n`);
  process.exit(1);
});
