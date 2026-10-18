# Orbit 1.0 threat model

Scope: Orbit Desktop and the Orbit phone app on one local network. This is a working review of what the code does today, not a certification. It has not had an outside review. Real-device coverage so far: QR pairing and the encrypted session ran between a Windows 11 PC and an iPhone (October 14, over a Windows hotspot). Every other path has automated tests but awaits the structured real-device pass in docs/TESTING.md.

## What is protected
- The computer: files, clipboard, installed apps, the pointer and keyboard, the agent (which can act for the owner).
- The pairing secrets: the phone credential, the desktop's TLS key.
- Privacy: prompts, clipboard text, file contents, dictated audio.

## Trust boundaries
1. Phone <-> desktop over the LAN: TLS to a self-signed desktop certificate. The phone pins that certificate's SHA-256 fingerprint, which it learns from the QR shown on the desktop screen. A hostname or CA is never trusted.
2. Pairing: one QR invitation, open for two minutes, shows on the desktop only. The phone gets a long random credential, stored in the OS secure store. Sessions derived from it expire.
3. Per-device permission scopes (agent, clipboard, files, launcher, input, dictation, memory), chosen at pairing time with `ORBIT_PAIR_SCOPES`. A device without a scope is refused with `SCOPE_DENIED`. Unknown command families are refused unless the device has full access.
4. Desktop owner: confirmation for remote pointer/keyboard and for remote terminal (one approved session at a time each, 30s default-Deny dialog), plus agent approvals (per sensitive step, relayed to the phone).

## Threats and what answers them
| Threat | Mitigation in code | Remaining gap |
|---|---|---|
| Another device on the Wi-Fi impersonates the desktop | Phone pins the leaf certificate fingerprint from the QR; local addresses only | Pinning is implemented in a native module (Kotlin OkHttp, Swift URLSession) that compiles in CI but has not yet run on a device |
| Another device pairs itself | QR invitation is shown only on the desktop, expires in two minutes, and is consumed on first use (before any disk write) | Someone who can see the desktop screen can pair |
| Stolen or leaked phone credential | Credential lives in the secure store; only a hash of it is kept on the desktop; sessions expire | The owner can list phones (`devices`) and unpair one from the desktop console or the phone's Settings -> Devices screen; it stops working immediately. No remote wipe of a lost phone |
| Compromised phone does too much | Scopes limit each device to the features it needs; the activity log records commands; agent kill switch ("Stop agent") survives restart | Full-access devices (paired before scopes existed) can use everything except input, which also needs a desktop confirmation |
| Agent does something the owner did not intend | Sensitive steps need approval from the phone; a task is owned by one device; audit trail of who asked and who approved (no prompt text stored); export for the owner | Approval text is written by the agent, so it can be vague. The Hermes approve/deny API body is unverified against a real gateway |
| Replayed or duplicated command | Idempotency keys for tasks; input sequence numbers consumed before acting, a failed batch is never replayed; file chunks are offset-checked and hash-verified | |
| Malicious file from the phone | Names are validated (no path parts, no reserved names), size capped at 1 GiB, per-chunk and whole-file SHA-256, files land in a private inbox, nothing is auto-opened | The owner still decides what to open |
| Path traversal / browsing the computer from the phone | The phone can only receive files the desktop owner explicitly offers; it cannot list folders | |
| Remote control abuse | Closed set of events and keys (no raw key codes or shortcuts with arbitrary codes); one session; heartbeat; ends on disconnect; default confirmation denies | The Windows driver (SendInput in a PowerShell worker) is covered by synthetic-adapter tests but untested on real hardware; both entrypoints gate remote input to Windows |
| Remote terminal abuse | Every session needs a Yes on the PC's screen (30s default-Deny); one session at a time; one command at a time; 60s default / 120s max per command; streamed output capped at 48 KB; 5-minute idle close; opt-in via ORBIT_ENABLE_TERMINAL=1 on the CLI, per-session dialog in the Electron app; Windows only at the entrypoints | No PTY by design - no interactive programs; shell state does not carry between commands (cd is tracked) |
| Clipboard leaks | Plain text only, 8 KB; the phone reads its own clipboard only while the app is in the foreground, and auto-sync can be switched off in Settings; a bounded history (last 50) is stored privately on the desktop | |
| Dictation audio leaks | Local engine only; audio is zeroed after use; temp WAV is overwritten and deleted; errors expose codes only | A real model is not installed or tested; the temp WAV exists on disk for the length of the transcription |
| Denial of service from a paired phone | One command at a time per session, size limits everywhere, connection cap, busy errors | |
| Secrets in logs | Activity log stores event types and outcomes, not payloads | |

## Known gaps to close before a public release
1. Run the native pinning module on iOS and Android (it compiles in CI); verify a wrong certificate is refused.
2. Exercise the Windows input driver and the desktop approval prompt on real hardware (both implemented, synthetic-tested).
3. Real-device tests of the whole path (QR scan, pin, session, each feature).
4. Verify the Hermes approval API against a real gateway.
5. Independent security review.
6. Packaging and signing for each OS.

## Reporting
Security issues: contact the repository owner privately; do not open public issues for them.
