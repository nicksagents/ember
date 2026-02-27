# verify_server

Purpose: confirm that a local server is actually listening and responding.

Inputs:
- host: requested host. If `0.0.0.0`, probing happens via `127.0.0.1`.
- port: target port.
- path: request path (optional, default `/`).
- timeoutMs: request timeout (optional).

Notes:
- Use immediately after `start_dev_server`.
- Do not claim the server is running until this tool succeeds.
