# Architecture

Orbit Desktop is a Node 24 + TypeScript service. Phones connect over an encrypted, certificate-pinned WSS channel after one-time QR pairing.

- `protocol/`: zod wire contracts (strict objects, bounded sizes).
- `command-router/`: authenticated dispatch, duplicate-request rejection, biometric gate for sensitive commands.
- `security-pairing/`: identity, pairing, sessions, per-device scopes, panic lock.
- Feature modules: clipboard-sync (with a bounded private history), file-transfer, app-launcher, input-simulation, system-control (power, volume, brightness, display theme), browser-tabs, terminal, automation, memory, dictation.
- `agent/`: runs tasks through the Hermes harness and records each one in a durable ledger with an exportable audit trail.
- `activity-log/`: bounded in-memory audit of every command outcome - metadata only, never payloads.
- `os-integration/`: per-OS adapters. Clipboard, apps, audio and system control have Windows + Linux implementations; pointer/keyboard input and the remote terminal are Windows-only today, gated behind opt-in flags and an on-PC approval.
- The Electron shell (`shell/`) wraps the same service with the pairing window and approval dialogs.
