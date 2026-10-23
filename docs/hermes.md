# Running agent tasks on Hermes

Orbit Desktop runs agent tasks through a local Hermes gateway using its Runs API (`POST /v1/runs`, `GET /v1/runs/{id}/events`, `/stop`, `/approval`). Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Setup:

1. In `~/.hermes/.env` set `API_SERVER_ENABLED=true` and an `API_SERVER_KEY`.
2. Start `hermes gateway` (listens on `http://127.0.0.1:8642`).
3. In the Orbit desktop app open Settings -> Agent tasks, paste the same key (and the gateway address if you changed it), and Save. The key is stored only in the computer's encrypted system storage (Windows DPAPI / macOS Keychain / Linux keyring); if the OS offers no secure storage, the app refuses to save it. The CLI entrypoint still takes `ORBIT_HERMES_API_KEY` and optionally `ORBIT_HERMES_URL` instead.

Behavior:

- Agent tasks are off unless `ORBIT_HERMES_API_KEY` is set.
- Only loopback endpoints are accepted by default.
- Each Orbit task uses its task ID as the Hermes `Idempotency-Key` and `session_id`.
- The run status endpoint decides success; the event stream only provides progress.
- Approval requests go to the phone. No answer within 5 minutes means deny.
- If the gateway restarts mid-run Hermes marks the run `interrupted`, and Orbit shows the task as failed or unknown. Runs are not resumed.
- Approval answers use the documented contract: `POST /v1/runs/{id}/approval` with `{ "request_id": "<prompt_id>", "execution_generation": <n>, "choice": "once" | "deny" }`. The identity comes from the `approval.request` event, falling back to `GET /v1/runs/{id}` `pending_controls`. Identityless or stale answers are refused with HTTP 409, and Orbit treats 409 as "already settled". Verified against the live docs (hermes-agent.nousresearch.com/docs/user-guide/features/api-server, October 24, 2026); not yet exercised against a real gateway.
