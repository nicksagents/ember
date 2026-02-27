# list_processes

Purpose: inspect running processes, especially local app servers.

Inputs:
- port: listening TCP port to inspect (optional).
- match: command substring filter (optional).
- limit: max rows to return (optional).

Notes:
- Use before stopping or restarting a project server.
- Prefer filtering by `port` when the user mentions a port number.
