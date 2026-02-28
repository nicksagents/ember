import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function resolvePathInput(value) {
  const home = os.homedir();
  const desktop = path.join(home, "Desktop");
  const workspaceRoot = process.cwd();
  let text = String(value || "").trim();
  if (!text) return "";

  if (text.startsWith("~/")) {
    text = path.join(home, text.slice(2));
  } else if (text === "~") {
    text = home;
  } else if (text === "desktop") {
    text = desktop;
  } else if (text.toLowerCase().startsWith("desktop/")) {
    text = path.join(desktop, text.slice("desktop/".length));
  } else if (!path.isAbsolute(text)) {
    text = path.join(workspaceRoot, text);
  }

  return path.resolve(text);
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEmpty(targetPath) {
  try {
    const entries = await readdir(targetPath);
    return entries.length === 0;
  } catch {
    return true;
  }
}

async function runCommand(command, { cwd, timeoutMs = 600000 } = {}) {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn("/bin/bash", ["-lc", command], {
        cwd,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : "Failed to spawn process",
        command,
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(),
        command,
        timedOut: true,
      });
    }, clampNumber(timeoutMs, 1000, 1800000, 600000));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : "Command failed"}`.trim(),
        command,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
        command,
      });
    });
  });
}

async function writeProjectManifest(projectPath, packageManager) {
  const manifestPath = path.join(projectPath, ".ember-project.json");
  const payload = {
    type: "nextjs-shadcn",
    packageManager,
    startCommand: `${packageManager} run dev`,
    installCommand:
      packageManager === "npm"
        ? "npm install"
        : packageManager === "pnpm"
          ? "pnpm install"
          : "yarn install",
    verify: {
      host: "0.0.0.0",
      port: 3000,
      path: "/",
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function detectPackageJson(projectPath) {
  try {
    const raw = await readFile(path.join(projectPath, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearDirectoryContents(targetPath) {
  const entries = await readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(targetPath, entry.name), { recursive: true, force: true })
    )
  );
}

export async function registerTools(registry) {
  registry.register({
    name: "scaffold_next_shadcn_project",
    description:
      "Scaffold a non-interactive Next.js project with shadcn/ui defaults in one step. Use for new app setup instead of raw shell commands.",
    parameters: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute path or desktop-relative path for the project directory",
        },
        packageManager: {
          type: "string",
          description: "npm | pnpm | yarn (default: npm)",
        },
      },
      required: ["projectPath"],
    },
    keywords: [
      "nextjs",
      "next",
      "shadcn",
      "scaffold",
      "project",
      "bootstrap",
      "create app",
    ],
    skillFile: "scaffold_next_shadcn_project.md",
    handler: async (args) => {
      const projectPath = resolvePathInput(args?.projectPath);
      const packageManager =
        ["npm", "pnpm", "yarn"].includes(String(args?.packageManager || "npm"))
          ? String(args.packageManager)
          : "npm";

      if (!projectPath) {
        return { error: "projectPath is required" };
      }

      const exists = await pathExists(projectPath);
      if (!exists) {
        await mkdir(projectPath, { recursive: true });
      } else {
        const isEmpty = await isDirectoryEmpty(projectPath);
        if (!isEmpty) {
          return {
            error:
              "Target directory is not empty. Use an empty folder or create a fresh project path.",
            projectPath,
          };
        }
      }

      const commands = [];
      const shadcnCreateCommand = `npx shadcn@latest create --template next --yes --base-color zinc`;
      const shadcnInitCommand = `npx shadcn@latest init --template next --yes --base-color zinc`;
      commands.push(shadcnCreateCommand);
      let strategy = "shadcn_create";
      let shadcnResult = await runCommand(shadcnCreateCommand, {
        cwd: projectPath,
        timeoutMs: 900000,
      });

      let packageJson = await detectPackageJson(projectPath);
      const looksLikeNextProject =
        packageJson?.dependencies?.next || packageJson?.devDependencies?.next;

      if (!shadcnResult.ok || !looksLikeNextProject) {
        if (!(await isDirectoryEmpty(projectPath)) && !looksLikeNextProject) {
          await clearDirectoryContents(projectPath);
        }
        strategy = "shadcn_init";
        commands.push(shadcnInitCommand);
        shadcnResult = await runCommand(shadcnInitCommand, {
          cwd: projectPath,
          timeoutMs: 900000,
        });
        packageJson = await detectPackageJson(projectPath);
      }

      const looksLikeNextProjectAfterInit =
        packageJson?.dependencies?.next || packageJson?.devDependencies?.next;
      if (!shadcnResult.ok || !looksLikeNextProjectAfterInit) {
        strategy = "create_next_app_then_shadcn";
        if (!(await isDirectoryEmpty(projectPath))) {
          await clearDirectoryContents(projectPath);
        }
        const createNextCommand = `npx create-next-app@latest . --typescript --tailwind --eslint --app --use-${packageManager} --yes`;
        commands.push(createNextCommand);
        const createNextResult = await runCommand(createNextCommand, {
          cwd: projectPath,
          timeoutMs: 900000,
        });
        if (!createNextResult.ok) {
          return {
            error: "Failed to scaffold Next.js project",
            projectPath,
            strategy,
            commands,
            results: [createNextResult, shadcnResult],
          };
        }

        commands.push(shadcnInitCommand);
        shadcnResult = await runCommand(shadcnInitCommand, {
          cwd: projectPath,
          timeoutMs: 900000,
        });
        packageJson = await detectPackageJson(projectPath);
      }

      if (!shadcnResult.ok) {
        return {
          error: "Next.js project was created but shadcn initialization failed",
          projectPath,
          strategy,
          commands,
          results: [shadcnResult],
          packageJsonPresent: Boolean(packageJson),
        };
      }

      const manifestPath = await writeProjectManifest(projectPath, packageManager);
      return {
        ok: true,
        created: true,
        projectPath,
        strategy,
        packageManager,
        framework: "nextjs-shadcn",
        startCommand: `${packageManager} run dev`,
        installCommand:
          packageManager === "npm"
            ? "npm install"
            : packageManager === "pnpm"
              ? "pnpm install"
              : "yarn install",
        manifestPath,
        commands,
        nextVersion:
          packageJson?.dependencies?.next ||
          packageJson?.devDependencies?.next ||
          null,
        hasComponentsJson: await pathExists(path.join(projectPath, "components.json")),
        hasPackageJson: await pathExists(path.join(projectPath, "package.json")),
      };
    },
  });
}
