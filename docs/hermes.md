# Running agent tasks on Hermes

Orbit Desktop runs agent tasks through a local Hermes gateway using its Runs API (`POST /v1/runs`, `GET /v1/runs/{id}/events`, `/stop`, `/approval`). Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Setup:

1. Install Hermes Agent with the API-server dependency, which the base install omits: `uv tool install --with aiohttp hermes-agent` (or add `aiohttp` to the pip environment). Without it `hermes gateway run` logs "API Server: aiohttp not installed" and no HTTP API ever listens.
2. In `~/.hermes/.env` set `API_SERVER_ENABLED=true` and an `API_SERVER_KEY`.
3. Start `hermes gateway run` (listens on `http://127.0.0.1:8642`; on v0.19.0 plain `hermes gateway` only prints subcommand help). Hermes also needs its own model provider configured (`hermes setup` or `model:` in `~/.hermes/config.yaml`); without one, runs are accepted and then fail with the provider's error, which Orbit shows on the phone.
4. In the Orbit desktop app open Settings -> Agent tasks, paste the same key (and the gateway address if you changed it), and Save. The key is stored only in the computer's encrypted system storage (Windows DPAPI / macOS Keychain / Linux keyring); if the OS offers no secure storage, the app refuses to save it. The CLI entrypoint still takes `ORBIT_HERMES_API_KEY` and optionally `ORBIT_HERMES_URL` instead.

Behavior:

- Agent tasks are off unless `ORBIT_HERMES_API_KEY` is set.
- Only loopback endpoints are accepted by default.
- Each Orbit task uses its task ID as the Hermes `Idempotency-Key` and `session_id`. Note: Hermes v0.19.0 does not honor `Idempotency-Key` on `/v1/runs` (verified live: the same key starts a new run every time, HTTP 202). Orbit sends it for forward compatibility, but the real duplicate guard is Orbit's own task ledger: a task is submitted exactly once, and a desktop restart marks an in-flight task's outcome as unknown instead of resubmitting it.
- The run status endpoint decides success; the event stream only provides progress.
- Approval requests go to the phone. No answer within 5 minutes means deny.
- If the gateway restarts mid-run Hermes marks the run `interrupted`, and Orbit shows the task as failed or unknown. Runs are not resumed.
- Approval answers: `POST /v1/runs/{id}/approval`. Against Hermes v0.19.0 the body is `{ "choice": "once" | "deny" }` and the gateway resolves whichever control is pending for the run; its `approval.request` event carries `command`, `description` and `choices` but no control identity, and the run status has no `pending_controls`. Orbit therefore answers with the plain choice when no identity exists, and with the documented identity-bound body (`request_id`, `execution_generation`, `choice`) when a newer gateway provides one. HTTP 409 (nothing pending / already settled) is tolerated either way.
- Verified live against Hermes Agent v0.19.0 on October 24, 2026: install, `hermes gateway run`, capabilities probe and auth rejection, run admission, status transitions, real SSE event stream (`data:`-only frames, type in the payload), tool progress, the full approval round-trip (phone decision reached the gateway and the run resumed), stop, and honest surfacing of provider errors. The model itself was a local stand-in; a real provider account is the owner's to configure.
