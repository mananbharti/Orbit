# Acceptance Matrix

Every feature is at exactly one verification level per platform:

- **Implemented** - code complete on `v1.1`, reviewed.
- **Automated test** - unit/integration tests in CI (desktop tests use synthetic OS adapters unless marked otherwise).
- **Real-device verified** - run and confirmed on Manan's Windows 11 (Omen) + iPhone.
- **Platform limitation** - the OS does not allow the full version; the limitation is named.

Preview screenshots shown during development use synthetic data (mock apps, mock volumes) unless labeled otherwise. "Working" in milestone notes means automated-tested; it never means device-verified.

## Manan's reported complaints

| Complaint | Status | Automated test | Real-device verified | Note |
| --- | --- | --- | --- | --- |
| Remote mouse does nothing ("mouse nahi chalta") | Implemented (was never wired into the Electron app; now enabled with an in-app approval dialog) | Integration tests over paired WSS + adapter unit tests | **Pending Windows** | Approval dialog replaces the raw PowerShell prompt |
| App launcher feels dead, no dock ("dock nahi chalta") | Implemented: 4-column grid, search, real 48px icons, batched loading | 11 launcher unit tests + 2 integration batches | **Pending Windows** (icon extraction) | Preview screenshots used mock icons |
| Received files vanish, nothing to click ("file sharing pe kuch nahi hai") | Implemented: Files tab with Open / Open in folder / Copy path, notifications, drag-drop send | Desktop shell smoke tests + transfer integration tests | **Pending Windows** | |
| Clipboard not automatic ("clipboard auto nahi hota") | Implemented both ways while the app is open; phone subscribes at connect | Sync unit tests + integration | **Pending iPhone+Windows** | Background sync: **platform limitation, see below** |
| Reconnect / connection visibility | Implemented: auto-reconnect with session renewal, connected-state everywhere | Session renewal tests | **Pending real network** | |
| Real Windows audio control | Implemented: master volume/mute + per-app mixer via Core Audio | Integration tests with synthetic adapter | **Pending Windows** | Adapter commands are real; untested on real Windows audio sessions |

## README device-feature rows

| # | Feature | Status | Automated test | Real-device verified | Platform limitation |
| --- | --- | --- | --- | --- | --- |
| 1 | Bidirectional clipboard sync | Implemented | Yes | Pending | Background: see iOS note |
| 2 | Clipboard history across devices | Implemented (last 50, both sources, tap-to-apply) | Yes | Pending | - |
| 3 | Direct file transfer (no cloud) | Implemented (chunked, resumable, hash-verified) | Yes | Pending | - |
| 4 | Native share-sheet integration | Not started | - | - | iOS share extension needs a native build |
| 5 | Drag-and-drop drop zone (desktop) | Implemented (A1) | Yes | Pending | - |
| 6 | Auto-organize transferred files | Implemented: received files land in inbox/<Type> (Documents, Images, Videos, Audio, Archives, Apps, Other), same-name deliveries step to " (2)" | Yes | Pending | - |
| 7 | Photo auto-backup to PC | Not started | - | - | - |
| 8 | Customizable launcher grid | Implemented: grid + search + long-press pin/unpin/move earlier-later; pins persisted on the desktop (stable app ids across restarts), shared by all phones | Yes (layout store, commands, id stability, corrupt-file recovery) | Pending | - |
| 9 | Context-aware launcher scenes | Partial: named scenes (save/edit/delete, one-tap launch-all, per-app failure reporting) persisted on the desktop; context triggers (time/place) not built | Yes (commands, persistence, partial-failure semantics) | Pending | - |
| 10 | Full mouse/touchpad control | Implemented (A5) | Yes | Pending | Windows + Linux only |
| 11 | Gyroscope mouse mode | Implemented: Gyro toggle on the Remote screen; rotation rate -> cursor velocity with tremor dead zone, ~30 updates/s | UI layer only (no unit tests - sensor glue); protocol path fully tested | Pending (sensitivity + axis signs need on-hand tuning) | Web preview hides the toggle; needs the dev-client build |
| 12 | Full keyboard + custom macros | Implemented: remote keyboard + letters/digits/F-keys now sendable with modifiers; named macros saved on the desktop, one tap runs every chord in one batch inside the approved control session | Yes (store, commands, VK translation, batching) | Pending | Letters/F-keys as remote-keyboard buttons pending; macros need an approved control session by design |
| 13 | System volume + per-app mixer | Implemented | Yes | Pending | Sessions addressed by PID |
| 14 | Power control (shutdown/sleep/restart/lock) | Implemented | Yes | Pending | - |
| 15 | Wake-on-LAN | Implemented: MACs in pairing payload + phone magic-packet sender + Wake button when PC is unreachable | Yes (packet bytes, MAC filtering, pairing pass-through) | Pending | Needs the desktop BIOS/NIC WoL enabled; iOS sends via react-native-udp (native module, dev-client build) |
| 16 | Display brightness + mode control | Partial: brightness done (null on desktops without backlight); mode control pending | Yes | Pending | Most desktops have no controllable backlight |
| 17 | Presentation mode | Implemented: Present screen with slide nav, Start/Black/White/End deck keys, laser pad (Ctrl+left-drag via held-key events) inside the approved control session | Yes (held-key op translation, schema) | Pending | Laser verified against PowerPoint's Ctrl+drag convention; needs real-device check |
| 18 | Browser tab control | Not started | - | - | Likely needs a browser extension |
| 19 | QR pairing + biometric confirmation | Implemented: Face ID/Touch ID gate before connecting or pairing (on by default), Settings toggle, graceful open when the phone has no biometrics | UI layer (native module glue); pairing protocol already tested | Pending | Desktop already requires Windows approval for control sessions; this adds the phone-side gate |
| 20 | Per-device permission scoping | Implemented: Settings -> Devices lists every paired device with its access; per-permission switches (Assistant, Clipboard, Files, Apps, Keyboard & Mouse, Dictation, Memory) or Full access; changes apply immediately and persist on the computer. Only full-access devices can manage devices (wire family fails closed); a device cannot change its own permissions | Yes: store write-through, list/set commands, self-scope and unknown-device rejection, phone API (247 desktop / 92 core) | Pending (needs a second paired device to see the list) | Phone UI is live; with one device paired the list shows only This iPhone |
| 21 | Activity log + panic lock | Implemented | Yes | Pending | - |
| 22 | Automation / scheduled actions | Implemented: the computer runs scheduled actions on its own clock (checks every 15s, fires once per matching minute, survives restarts, never double-fires after one) - Sleep, Lock, or Open a scene; phone UI: Automations chip on Home, big-time list with enable switches, editor with action picker, hour/minute steppers and weekday chips. Full-access devices only (family fails closed: schedules can power the machine) | Yes: store persistence + corrupt recovery, tick firing/day/skip/dedupe logic, command auth + validation, phone API (251 desktop / 94 core) | Pending | Keyboard-macro actions deliberately excluded: remote input requires a live approved control session by design |
| 23 | Multi-PC support | Implemented: the phone holds a list of paired computers (secure store, migrates the old single-computer record on first launch); Computers screen (Settings -> Computers or tap the computer name on Home) switches the active computer with the Face ID gate, adds a computer via QR, forgets with a two-tap confirm; endpoint changes rewrite the matching record; re-pairing the same computer replaces its credential | App layer: typecheck + preview renders (no app test runner); storage migration logic reviewed | Pending (needs two real computers) | Switching disconnects cleanly but in-flight transfers on the old computer are dropped |
| 24 | Developer/terminal remote access | Implemented: approved remote shell sessions - every session needs a Yes on the PC's screen (30s default-Deny dialog, same pattern as remote control), one session at a time, one command at a time, 5-min idle close, streamed stdout/stderr under a 48KB cap (killed + marked truncated past it), 60s default / 120s max per command, Stop button kills the running command, cd tracked by the service itself | Yes: approval gate + slot reservation, BUSY/foreign-session rejection, streamed output events, cd tracking + bad-dir handling, interrupt, clean stop (256 desktop / 97 core) | Pending | No PTY: no interactive programs, and shell state (variables, functions) does not carry between commands - cd is the supported way to move; Windows cmd.exe and POSIX sh both wired; CLI needs ORBIT_ENABLE_TERMINAL=1, Electron app asks at the PC |
| 25 | AI-driven natural-language control | Planned (upstream), out of scope for v1.1 | - | - | - |

## iOS clipboard background: what is actually possible

Verified against Apple's developer forums and OWASP's iOS pasteboard notes (mas.owasp.org/MASTG-KNOW-0083, October 2026):

- **Since iOS 9, only foreground apps can access the pasteboard.** An app suspended in the background cannot read or react to the clipboard. Always-on clipboard sync in the background is not possible on stock iOS.
- **Since iOS 16, reading the clipboard without a user gesture shows a paste confirmation prompt.** Our phone->PC auto-detect while Orbit is open counts as programmatic access. Manan can silence it: Settings -> Apps -> Orbit -> Paste from Other Apps -> Allow (iOS 16.1+).
- **PC -> phone writes need no prompt**, but only while Orbit is running in the foreground; iOS suspends the app seconds after leaving it and the connection drops.
- The only near-background path would be APNs silent push waking the app briefly - that needs a push server and is not built. Not promised.
