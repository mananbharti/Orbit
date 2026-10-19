# Changelog

## v1.1 (merged to main Oct 19, 2026)

The first full version of Orbit: a private phone-companion for your PC over your own Wi-Fi - no cloud, no accounts, TLS-pinned pairing by QR code.

### Phone to PC
- Clipboard sync both ways, with echo suppression and a 50-entry private history on the PC
- Dictation: hold to talk on the phone, text typed on the PC - on-device whisper, audio never leaves the machine and is wiped after every clip
- Files both ways: phone to PC inbox (auto-organized by type), PC files browsable from the phone
- Remote input: phone as trackpad and keyboard (Windows)
- Browser tabs: see, open, close and switch the PC's browser tabs through the companion extension
- App launcher with context scenes (time and place triggers), per-app audio mixer, system control (lock/sleep/restart/shutdown, volume, brightness, dark mode)
- Panic lock: one tap locks the PC and unpairs the phone
- Terminal: run a bounded set of commands from the phone (Windows, approval-gated)
- Memory: a small local graph the assistant remembers people and facts in
- Automations and an agent runtime with owner approval for privileged actions

### Security model
- Pairing is one-time and QR-verified; credentials are stored hashed with 0600 permissions
- Sessions expire, heartbeats enforce liveness, and a revoked phone is cut off on its next request
- Scoped pairing: a phone can be limited to chosen feature families; browser tabs require full access
- Privileged actions (input device, terminal) need an explicit on-PC approval
- Every agent action lands in a bounded audit trail exportable as CSV/JSON

### Fixes during hardening
- system.panic no longer reports "locked" on machines with no lock adapter - it honestly reports "unpaired" (the phone is revoked either way)
- Windows brightness reports null instead of a fake 0% on PCs without a controllable backlight
- Permission changes on a paired phone now apply to its live session on the next command - previously they only took effect after the phone reconnected
- Clipboard history apply now syncs the chosen clip back to the phone that tapped it - the desktop was excluding the applying phone from the change event, so tapping an old clip updated the PC but looked dead on the phone

### Testing
- 345 desktop tests, 132 phone-core tests, 73 end-to-end tests (phone core against the real desktop over real pinned TLS) - desktop suites green in CI on Ubuntu and Windows, e2e on Ubuntu
- Real-device verification on the Omen + iPhone is in progress; per-feature status lives in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

### Known limits (by design or platform)
- iOS clipboard, photo backup and place triggers work while the app is open (iOS platform rule, not a bug)
- Android share-target and the iOS Share Extension target are deferred native work
- Remote input and terminal are Windows-only
- Night light toggle is deliberately unsupported (undocumented registry state; writing it risks corrupting Windows Settings)
