# Running agent tasks on Hermes

Orbit Desktop runs agent tasks through a local Hermes gateway using its Runs API (`POST /v1/runs`, `GET /v1/runs/{id}/events`, `/stop`, `/approval`). Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Setup:

1. In `~/.hermes/.env` set `API_SERVER_ENABLED=true` and an `API_SERVER_KEY`.
2. Start `hermes gateway` (listens on `http://127.0.0.1:8642`).
3. Start Orbit Desktop with `ORBIT_HERMES_API_KEY` set to the same key. Optionally set `ORBIT_HERMES_URL`.

Behavior:

- Agent tasks are off unless `ORBIT_HERMES_API_KEY` is set.
- Only loopback endpoints are accepted by default.
- Each Orbit task uses its task ID as the Hermes `Idempotency-Key` and `session_id`.
- The run status endpoint decides success; the event stream only provides progress.
- Approval requests go to the phone. No answer within 5 minutes means deny.
- If the gateway restarts mid-run Hermes marks the run `interrupted`, and Orbit shows the task as failed or unknown. Runs are not resumed.
- Open item: the approval request body (`decision: once|deny`) is inferred from the docs wording; confirm against a live gateway.
