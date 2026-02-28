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

async function clearDirectoryContents(targetPath) {
  const entries = await readdir(targetPath, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      rm(path.join(targetPath, entry.name), { recursive: true, force: true })
    )
  );
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

async function detectPackageJson(projectPath) {
  try {
    const raw = await readFile(path.join(projectPath, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function detectPyproject(projectPath) {
  try {
    const raw = await readFile(path.join(projectPath, "pyproject.toml"), "utf8");
    return raw;
  } catch {
    return "";
  }
}

function buildInstallCommand(packageManager) {
  return packageManager === "npm"
    ? "npm install"
    : packageManager === "pnpm"
      ? "pnpm install"
      : "yarn install";
}

function buildManifestForPreset(preset, packageManager) {
  const commonNodeStart = `${packageManager} run dev`;
  switch (preset) {
    case "nextjs-shadcn":
      return {
        type: preset,
        packageManager,
        startCommand: commonNodeStart,
        installCommand: buildInstallCommand(packageManager),
        verify: { host: "0.0.0.0", port: 3000, path: "/" },
      };
    case "vite-react-ts":
    case "vite-vue-ts":
    case "vite-vanilla-ts":
      return {
        type: preset,
        packageManager,
        startCommand: commonNodeStart,
        installCommand: buildInstallCommand(packageManager),
        verify: { host: "0.0.0.0", port: 3000, path: "/" },
      };
    case "electron-forge-vite-ts":
      return {
        type: preset,
        packageManager,
        startCommand:
          packageManager === "npm"
            ? "npm start"
            : packageManager === "pnpm"
              ? "pnpm start"
              : "yarn start",
        installCommand: buildInstallCommand(packageManager),
        verify: null,
      };
    case "expo-default":
      return {
        type: preset,
        packageManager,
        startCommand:
          packageManager === "npm"
            ? "npm run start"
            : packageManager === "pnpm"
              ? "pnpm start"
              : "yarn start",
        installCommand: buildInstallCommand(packageManager),
        verify: null,
      };
    case "fastapi-uv":
      return {
        type: preset,
        packageManager: "uv",
        startCommand: "uv run fastapi dev main.py --host 0.0.0.0 --port 3000",
        installCommand: "uv sync",
        verify: { host: "0.0.0.0", port: 3000, path: "/" },
      };
    case "python-uv-app":
      return {
        type: preset,
        packageManager: "uv",
        startCommand: "uv run main.py",
        installCommand: "uv sync",
        verify: null,
      };
    case "python-uv-package":
      return {
        type: preset,
        packageManager: "uv",
        startCommand: "uv run",
        installCommand: "uv sync",
        verify: null,
      };
    default:
      return {
        type: preset,
        packageManager,
        startCommand: commonNodeStart,
        installCommand: `${packageManager} install`,
        verify: null,
      };
  }
}

async function writeProjectManifest(projectPath, preset, packageManager) {
  const manifestPath = path.join(projectPath, ".ember-project.json");
  const payload = buildManifestForPreset(preset, packageManager);
  await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { manifestPath, payload };
}

async function scaffoldNextShadcn(projectPath, packageManager) {
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
  let looksLikeNextProject =
    packageJson?.dependencies?.next || packageJson?.devDependencies?.next;

  if (!shadcnResult.ok || !looksLikeNextProject) {
    if (!(await isDirectoryEmpty(projectPath)) && !looksLikeNextProject) {
      await clearDirectoryContents(projectPath);
    }
    commands.push(shadcnInitCommand);
    strategy = "shadcn_init";
    shadcnResult = await runCommand(shadcnInitCommand, {
      cwd: projectPath,
      timeoutMs: 900000,
    });
    packageJson = await detectPackageJson(projectPath);
    looksLikeNextProject =
      packageJson?.dependencies?.next || packageJson?.devDependencies?.next;
  }

  if (!shadcnResult.ok || !looksLikeNextProject) {
    if (!(await isDirectoryEmpty(projectPath))) {
      await clearDirectoryContents(projectPath);
    }
    strategy = "create_next_app_then_shadcn";
    const createNextCommand = `npx create-next-app@latest . --typescript --tailwind --eslint --app --use-${packageManager} --yes`;
    commands.push(createNextCommand);
    const createNextResult = await runCommand(createNextCommand, {
      cwd: projectPath,
      timeoutMs: 900000,
    });
    if (!createNextResult.ok) {
      return {
        ok: false,
        error: "Failed to scaffold Next.js project",
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
    looksLikeNextProject =
      packageJson?.dependencies?.next || packageJson?.devDependencies?.next;
  }

  if (!shadcnResult.ok || !looksLikeNextProject) {
    return {
      ok: false,
      error: "Next.js project was created but shadcn initialization failed",
      strategy,
      commands,
      results: [shadcnResult],
    };
  }

  return {
    ok: true,
    strategy,
    commands,
    packageJson,
  };
}

async function scaffoldVite(projectPath, packageManager, template) {
  const commands = [];
  const command =
    packageManager === "npm"
      ? `npm create vite@latest . -- --template ${template} --no-interactive`
      : packageManager === "pnpm"
        ? `pnpm create vite . --template ${template} --no-interactive`
        : `yarn create vite . --template ${template} --no-interactive`;
  commands.push(command);
  const result = await runCommand(command, {
    cwd: projectPath,
    timeoutMs: 900000,
  });
  const packageJson = await detectPackageJson(projectPath);
  const looksValid = packageJson?.scripts?.dev && packageJson?.devDependencies?.vite;
  if (!result.ok || !looksValid) {
    return {
      ok: false,
      error: "Failed to scaffold Vite project",
      commands,
      results: [result],
    };
  }
  return {
    ok: true,
    strategy: "create_vite",
    commands,
    packageJson,
  };
}

async function scaffoldExpo(projectPath) {
  const commands = [];
  const command = "npx create-expo-app@latest . --yes";
  commands.push(command);
  const result = await runCommand(command, {
    cwd: projectPath,
    timeoutMs: 900000,
  });
  const packageJson = await detectPackageJson(projectPath);
  const looksValid =
    packageJson?.dependencies?.expo &&
    (packageJson?.scripts?.start || packageJson?.scripts?.android);
  if (!result.ok || !looksValid) {
    return {
      ok: false,
      error: "Failed to scaffold Expo project",
      commands,
      results: [result],
    };
  }
  return {
    ok: true,
    strategy: "create_expo_app",
    commands,
    packageJson,
  };
}

async function scaffoldElectron(projectPath, packageManager) {
  const commands = [];
  const parentDir = path.dirname(projectPath);
  const projectName = path.basename(projectPath);
  const command =
    `NODE_INSTALLER=${packageManager} ` +
    `npx create-electron-app@latest "${projectName}" --template=vite-typescript`;
  commands.push(command);

  if (await pathExists(projectPath)) {
    await rm(projectPath, { recursive: true, force: true });
  }

  const result = await runCommand(command, {
    cwd: parentDir,
    timeoutMs: 900000,
  });
  const packageJson = await detectPackageJson(projectPath);
  const looksValid =
    Boolean(packageJson?.scripts?.start) &&
    Boolean(
      packageJson?.devDependencies?.["@electron-forge/cli"] ||
        packageJson?.devDependencies?.["@electron-forge/plugin-vite"] ||
        packageJson?.devDependencies?.["@electron-forge/plugin-webpack"]
    );

  if (!result.ok || !looksValid) {
    return {
      ok: false,
      error: "Failed to scaffold Electron project",
      commands,
      results: [result],
    };
  }

  return {
    ok: true,
    strategy: "create_electron_app",
    commands,
    packageJson,
  };
}

async function scaffoldPythonUv(projectPath, preset) {
  const commands = [];
  const command =
    preset === "python-uv-package" ? "uv init --package" : "uv init";
  commands.push(command);
  const result = await runCommand(command, {
    cwd: projectPath,
    timeoutMs: 300000,
  });
  const pyproject = await detectPyproject(projectPath);
  const looksValid = pyproject.includes("[project]");
  if (!result.ok || !looksValid) {
    return {
      ok: false,
      error: "Failed to scaffold uv Python project",
      commands,
      results: [result],
    };
  }
  return {
    ok: true,
    strategy: "uv_init",
    commands,
    pyprojectPresent: true,
  };
}

async function scaffoldFastApi(projectPath) {
  const commands = [];
  const initCommand = "uv init";
  commands.push(initCommand);
  const initResult = await runCommand(initCommand, {
    cwd: projectPath,
    timeoutMs: 300000,
  });
  let pyproject = await detectPyproject(projectPath);
  let looksValid = pyproject.includes("[project]");
  if (!initResult.ok || !looksValid) {
    return {
      ok: false,
      error: "Failed to initialize FastAPI project with uv",
      commands,
      results: [initResult],
    };
  }

  const addDepsCommand = `uv add "fastapi[standard]"`;
  commands.push(addDepsCommand);
  const addDepsResult = await runCommand(addDepsCommand, {
    cwd: projectPath,
    timeoutMs: 300000,
  });
  pyproject = await detectPyproject(projectPath);
  looksValid = /\bfastapi\b/i.test(pyproject);
  if (!addDepsResult.ok || !looksValid) {
    return {
      ok: false,
      error: "FastAPI dependencies were not added successfully",
      commands,
      results: [initResult, addDepsResult],
    };
  }

  await writeFile(
    path.join(projectPath, "main.py"),
    [
      "from fastapi import FastAPI",
      "",
      'app = FastAPI(title="Ember FastAPI App")',
      "",
      "",
      '@app.get("/")',
      "def read_root():",
      '    return {"status": "ok", "message": "Hello from Ember FastAPI"}',
      "",
    ].join("\n"),
    "utf8"
  );

  return {
    ok: true,
    strategy: "uv_init_fastapi",
    commands,
    pyprojectPresent: true,
  };
}

const SUPPORTED_PRESETS = {
  "nextjs-shadcn": {
    framework: "nextjs",
    language: "typescript",
  },
  "vite-react-ts": {
    framework: "vite-react",
    language: "typescript",
  },
  "vite-vue-ts": {
    framework: "vite-vue",
    language: "typescript",
  },
  "vite-vanilla-ts": {
    framework: "vite-vanilla",
    language: "typescript",
  },
  "electron-forge-vite-ts": {
    framework: "electron",
    language: "typescript",
  },
  "expo-default": {
    framework: "expo",
    language: "typescript",
  },
  "fastapi-uv": {
    framework: "fastapi",
    language: "python",
  },
  "python-uv-app": {
    framework: "python",
    language: "python",
  },
  "python-uv-package": {
    framework: "python",
    language: "python",
  },
};

export async function registerTools(registry) {
  registry.register({
    name: "scaffold_project",
    description:
      "Scaffold a new project from a supported preset like Next.js, Vite, Electron, Expo, FastAPI, or Python uv. Non-interactive and optimized for local agents.",
    parameters: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute path or desktop-relative path for the project directory",
        },
        preset: {
          type: "string",
          description:
            "nextjs-shadcn | vite-react-ts | vite-vue-ts | vite-vanilla-ts | electron-forge-vite-ts | expo-default | fastapi-uv | python-uv-app | python-uv-package",
        },
        packageManager: {
          type: "string",
          description: "npm | pnpm | yarn (default: npm for JS presets)",
        },
      },
      required: ["projectPath", "preset"],
    },
    keywords: [
      "scaffold",
      "bootstrap",
      "template",
      "starter",
      "nextjs",
      "vite",
      "electron",
      "expo",
      "fastapi",
      "python",
      "uv",
      "project",
    ],
    skillFile: "scaffold_project.md",
    handler: async (args) => {
      const projectPath = resolvePathInput(args?.projectPath);
      const preset = String(args?.preset || "").trim();
      const packageManager =
        ["npm", "pnpm", "yarn"].includes(String(args?.packageManager || "npm"))
          ? String(args.packageManager)
          : "npm";

      if (!projectPath) return { error: "projectPath is required" };
      if (!SUPPORTED_PRESETS[preset]) {
        return {
          error: `Unsupported preset: ${preset}`,
          supportedPresets: Object.keys(SUPPORTED_PRESETS),
        };
      }

      const exists = await pathExists(projectPath);
      if (!exists) {
        await mkdir(projectPath, { recursive: true });
      } else {
        const empty = await isDirectoryEmpty(projectPath);
        if (!empty) {
          return {
            error:
              "Target directory is not empty. Use an empty folder or create a fresh project path.",
            projectPath,
          };
        }
      }

      let scaffoldResult;
      if (preset === "nextjs-shadcn") {
        scaffoldResult = await scaffoldNextShadcn(projectPath, packageManager);
      } else if (
        preset === "vite-react-ts" ||
        preset === "vite-vue-ts" ||
        preset === "vite-vanilla-ts"
      ) {
        const templateMap = {
          "vite-react-ts": "react-ts",
          "vite-vue-ts": "vue-ts",
          "vite-vanilla-ts": "vanilla-ts",
        };
        scaffoldResult = await scaffoldVite(
          projectPath,
          packageManager,
          templateMap[preset]
        );
      } else if (preset === "electron-forge-vite-ts") {
        scaffoldResult = await scaffoldElectron(projectPath, packageManager);
      } else if (preset === "expo-default") {
        scaffoldResult = await scaffoldExpo(projectPath);
      } else if (preset === "fastapi-uv") {
        scaffoldResult = await scaffoldFastApi(projectPath);
      } else if (
        preset === "python-uv-app" ||
        preset === "python-uv-package"
      ) {
        scaffoldResult = await scaffoldPythonUv(projectPath, preset);
      } else {
        scaffoldResult = {
          ok: false,
          error: `Preset not implemented: ${preset}`,
        };
      }

      if (!scaffoldResult?.ok) {
        return {
          ...scaffoldResult,
          projectPath,
          preset,
          packageManager,
        };
      }

      const { manifestPath, payload } = await writeProjectManifest(
        projectPath,
        preset,
        packageManager
      );

      return {
        ok: true,
        created: true,
        projectPath,
        preset,
        packageManager: payload.packageManager,
        framework: SUPPORTED_PRESETS[preset].framework,
        language: SUPPORTED_PRESETS[preset].language,
        startCommand: payload.startCommand,
        installCommand: payload.installCommand,
        verify: payload.verify,
        manifestPath,
        strategy: scaffoldResult.strategy,
        commands: scaffoldResult.commands,
      };
    },
  });
}
