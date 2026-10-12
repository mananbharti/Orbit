# Architecture

Orbit Desktop is a Node 24 + TypeScript service. Phones connect over an encrypted, certificate-pinned WSS channel after one-time QR pairing.

- `protocol/`: zod wire contracts (strict objects, bounded sizes).
- `command-router/`: authenticated dispatch, duplicate-request rejection, biometric gate for sensitive commands.
- `security-pairing/`: identity, pairing, sessions.
- Feature modules: clipboard-sync, file-transfer, app-launcher, input-simulation.
- `activity-log/`: in-memory audit trail of every command outcome.
- Next: an `agent` module runs tasks through a harness over MCP and records each task in a durable ledger (see ROADMAP.md, P1 and P2).
