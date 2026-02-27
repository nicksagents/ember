# run_command

Purpose: run a shell command.

Inputs:
- command: shell command string.
- cwd: working directory (optional).
- timeoutMs: kill process after this time (optional).
- env: map of environment variables (optional).

Notes:
- Use for build, test, git, or system inspection tasks.
- Keep commands focused; avoid unnecessary pipelines.
- Policy guard blocks commands that appear to write into `~` or any `ember` path.
