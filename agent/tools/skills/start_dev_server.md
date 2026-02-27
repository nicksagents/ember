# start_dev_server

Purpose: start a local project dev server in the background.

Inputs:
- cwd: project directory.
- command: dev command such as `npm run dev` (optional).
- host: bind host, usually `0.0.0.0` (optional).
- port: bind port, usually `3000` (optional).
- env: extra environment variables (optional).

Notes:
- Prefer this over raw `run_command` for Next.js, Vite, and similar dev servers.
- Always verify with `verify_server` before claiming success.
