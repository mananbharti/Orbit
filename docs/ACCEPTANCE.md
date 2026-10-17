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
| 8 | Customizable launcher grid | Partial: grid + search done; pin/reorder pending | Yes (grid) | Pending | - |
| 9 | Context-aware launcher scenes | Not started | - | - | - |
| 10 | Full mouse/touchpad control | Implemented (A5) | Yes | Pending | Windows + Linux only |
| 11 | Gyroscope mouse mode | Not started | - | - | - |
| 12 | Full keyboard + custom macros | Partial: remote keyboard done; macros pending | Yes (keyboard) | Pending | - |
| 13 | System volume + per-app mixer | Implemented | Yes | Pending | Sessions addressed by PID |
| 14 | Power control (shutdown/sleep/restart/lock) | Implemented | Yes | Pending | - |
| 15 | Wake-on-LAN | Implemented: MACs in pairing payload + phone magic-packet sender + Wake button when PC is unreachable | Yes (packet bytes, MAC filtering, pairing pass-through) | Pending | Needs the desktop BIOS/NIC WoL enabled; iOS sends via react-native-udp (native module, dev-client build) |
| 16 | Display brightness + mode control | Partial: brightness done (null on desktops without backlight); mode control pending | Yes | Pending | Most desktops have no controllable backlight |
| 17 | Presentation mode | Not started | - | - | - |
| 18 | Browser tab control | Not started | - | - | Likely needs a browser extension |
| 19 | QR pairing + biometric confirmation | Partial: QR pairing done; biometric confirm pending | Yes (pairing) | Pending | - |
| 20 | Per-device permission scoping | Partial: scope system exists on desktop; UI pending | Yes (scopes) | Pending | - |
| 21 | Activity log + panic lock | Implemented | Yes | Pending | - |
| 22 | Automation / scheduled actions | Not started | - | - | - |
| 23 | Multi-PC support | Not started | - | - | - |
| 24 | Developer/terminal remote access | Not started | - | - | - |
| 25 | AI-driven natural-language control | Planned (upstream), out of scope for v1.1 | - | - | - |

## iOS clipboard background: what is actually possible

Verified against Apple's developer forums and OWASP's iOS pasteboard notes (mas.owasp.org/MASTG-KNOW-0083, October 2026):

- **Since iOS 9, only foreground apps can access the pasteboard.** An app suspended in the background cannot read or react to the clipboard. Always-on clipboard sync in the background is not possible on stock iOS.
- **Since iOS 16, reading the clipboard without a user gesture shows a paste confirmation prompt.** Our phone->PC auto-detect while Orbit is open counts as programmatic access. Manan can silence it: Settings -> Apps -> Orbit -> Paste from Other Apps -> Allow (iOS 16.1+).
- **PC -> phone writes need no prompt**, but only while Orbit is running in the foreground; iOS suspends the app seconds after leaving it and the connection drops.
- The only near-background path would be APNs silent push waking the app briefly - that needs a push server and is not built. Not promised.
