# kill_process

Purpose: stop a running process cleanly.

Inputs:
- pid: process id to stop (optional).
- port: listening TCP port whose process should be stopped (optional).
- force: use SIGKILL instead of SIGTERM (optional).

Notes:
- Prefer `port` for local web servers.
- Use before starting a replacement server on the same port.
