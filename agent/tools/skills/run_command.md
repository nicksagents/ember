# run_command

Purpose: run a shell command.

Inputs:
- command: shell command string.
- cwd: working directory (optional).
- timeoutMs: kill process after this time (optional).
- background: run detached and return immediately (optional, default false).
- env: map of environment variables (optional).

Notes:
- Use for build, test, git, or system inspection tasks.
- For long-running servers (`npm run dev`, watchers), set `background: true` so chat can continue.
- Keep commands focused; avoid unnecessary pipelines.
- Policy guard blocks commands that appear to write into `~` or any `ember` path.
