# Orbit 1.0 Roadmap

Agent-first phasing. Each phase ships something usable. Status is tracked in the Notion build tracker.

| Phase | Goal | Key tasks |
|---|---|---|
| P0 Foundation | Repo, CI, docs, shared protocol | CI workflow, architecture and security docs, agent-task protocol |
| P1 Phone app + agent demo | Pair a phone, give a task, watch it run | Expo app, QR pairing, live task status, MCP bridge to the Hermes harness |
| P2 Trust layer + task ledger | Safe, resumable agent work | Permission scopes, approval prompts, audit log, durable task checkpoints, restart reconciliation |
| P3 Ecosystem basics | Phone-to-PC essentials | Clipboard, file transfer, app launcher, remote mouse and keyboard in the phone app |
| P4 Voice + graph memory | Talk to Orbit, it remembers | Local offline dictation (Whisper-family), voice input, memory graph, retrieval |
| P5 Hardening + release | Ship it | Security review, e2e tests, packaging, docs |

Rules: the pairing and session security in `desktop/src/security-pairing` is the base for every phase. New commands go through the command router, zod validation and the activity log.
