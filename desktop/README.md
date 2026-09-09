# Orbit Desktop

The Node.js + TypeScript background service for Orbit. Phases 1–2 provide the **Command Router**, **WebSocket** encrypted command channel, **QR Code Pairing**, durable device credentials, automatic session renewal, mDNS/Bonjour discovery, and an in-memory **Activity Log**. A TypeScript integration client exercises the channel while Orbit Mobile remains a later phase.

Phase 3 adds **Clipboard Sync**: bidirectional Unicode plain text, up to 8 KiB in UTF-8, through authenticated connection-scoped subscriptions. Windows and Linux adapters are wired into the service and TypeScript integration client. Phase 4 adds **File Transfer**: authenticated uploads and explicitly accepted downloads, chunk integrity checks, durable checkpoints, and resume after reconnect or restart. Phase 5 adds **App Launcher**: listing registered desktop applications and requesting their activation through Windows Shell or Linux GIO. Input Simulation, Power & Session, and Orbit Mobile remain later phases. The root [README](../README.md) remains the product scope reference.

## Test the Module

Requirements: Node.js 24 or newer and npm. No OpenSSL installation is needed. Windows uses its built-in PowerShell ACL APIs for private storage; Linux uses owner-only filesystem permissions.

```bash
cd desktop
npm ci
npm run typecheck
npm test
npm run test:lan
```

In PowerShell, use `npm.cmd` if local execution policy blocks `npm.ps1`.

The default suite generates temporary self-signed certificates and device credentials, runs real WSS servers on loopback, and removes its temporary files afterward. It covers certificate pinning, one-time enrollment, persistence, renewal, malformed messages, biometric gating, events, and dropped connections. Clipboard tests use synthetic OS adapters to verify both directions, connection isolation, stale-write rejection, echo suppression, cleanup, and resubscription without replay. The default suite does not touch the OS clipboard, simulate input, or change power state.

File Transfer tests cover chunk conflicts, whole-file integrity, lease and ownership isolation, destination collisions, changed sources, cancellation, authorization loss during verification, quotas, expiry, restart recovery, and renewal at 3,000 commands. All files are synthetic and temporary.

App Launcher tests cover bounded catalogs, registration changes, strict payload rejection, authorization loss before activation, native helper failures, XDG precedence/visibility, and interrupted activation without replay. Activation is synthetic in automated tests; they never open installed applications.

`test:lan` additionally exercises real mDNS multicast discovery followed by pinned HTTPS pairing, authenticated WSS, bidirectional Clipboard Sync with synthetic OS adapters, uploads/downloads with synthetic files, and synthetic app activation. It needs multicast access on the host; a sandbox or firewall blocking UDP 5353 causes a failure, not a skipped test. These are desktop/Node tests, not real-phone validation.

Approved runtime dependencies are `ws` (WebSocket), `zod` (boundary validation), `selfsigned` (certificate generation), `qrcode` (local SVG rendering), and `bonjour-service` (mDNS). Node supplies HTTPS, TLS, crypto, and the test runner. TypeScript and type definitions are development dependencies. Versions are pinned in `package-lock.json`.

## Run the Service

From `desktop/`, start the service in one PowerShell terminal:

```powershell
$env:ORBIT_HOST = "127.0.0.1"
$env:ORBIT_PORT = "8765"
$env:ORBIT_DATA_DIR = "$PWD/.local/service"
npm.cmd start -- --pair
```

First startup creates an owner-only data directory, a persistent service UUID, and an EC P-256 self-signed certificate signed with SHA-256. Certificates last 365 days and bind to the stable identity name `orbit-<service UUID>.local`. The client verifies that name and the QR pin; DHCP address changes do not require certificate replacement. An expired or corrupt identity fails closed and is never silently regenerated.

Normal startup leaves pairing closed. `--pair`, or entering `pair` in the running service terminal, explicitly opens one two-minute invitation. Open `.local/service/pairing.svg` to view the QR. The matching `pairing.json` is provided for this phase's integration client. Both files are private enrollment artifacts: do not commit, publish, or paste them into logs. A replacement invitation invalidates the old one, and redemption consumes it once. The files are removed at expiry or graceful shutdown.

In a second PowerShell terminal, also from `desktop/`, pair once:

```powershell
$env:ORBIT_CLIENT_DIR = "$PWD/.local/client"
npm.cmd run client -- pair .local/service/pairing.json
npm.cmd run client -- connect
```

The client discovers the public certificate through mDNS, checks the QR fingerprint, redeems the invitation over verified HTTPS, and saves its durable credential privately. Repeating the `pair` command with the same invitation must fail. Subsequent `connect` runs reuse the saved credential.

While connected, enter:

```json
{"type":"clipboard.subscribe","payload":{}}
```

Expect `Command succeeded; result omitted.` when the desktop clipboard is available. This explicitly subscribes that connection to future clipboard events; generic `connect` mode does not subscribe automatically or apply received text to its local OS. To enable bidirectional native Clipboard Sync and automatic resubscription, enter `quit`, then run `npm run client -- clipboard` instead. Leave either mode connected for about four minutes to observe automatic `reconnecting` / `connected` status without another QR scan. Enter `quit` to stop either process. Restart the service while keeping the client running to exercise automatic reconnection with its durable credential.

For a second machine on the LAN, set `ORBIT_HOST` to the desktop's private IPv4 address before startup. The loopback default is for same-machine testing. Wildcard and public-address binds are rejected; IPv6 LAN discovery/binding remain unimplemented. mDNS uses UDP 5353 and WSS uses the configured port (8765 by default). The client re-resolves the same pinned desktop on reconnect. No firewall rules are changed by Orbit.

`identity.json` stores the private key and certificate together; `credentials.json` stores only SHA-256 hashes of random 32-byte, base64url device credentials. Writes use atomic replacement and flushed temporary files. `paired-desktop.json` in the client directory contains its credential and pinned public identity. Existing data directories must already be owner-only; Orbit rejects unsafe permissions instead of changing an existing directory's ACL. `.local/` is ignored by Git.

Only one service may use a data directory at a time. An exclusive `service.lock` prevents concurrent enrollment/identity writes. After an ungraceful process termination, inspect the recorded PID and verify that process is gone before manually removing the stale lock. Do not remove an active service's lock. Never delete or replace `identity.json` as a connection workaround: changing the certificate requires explicit re-pairing.

Phase 1's `ORBIT_TLS_CERT`, `ORBIT_TLS_KEY`, and `ORBIT_CREDENTIAL_STORE` overrides are rejected in this managed identity flow. Existing hand-provisioned identities are not automatically imported or rotated; use a separately named private data directory for Phase 2 testing and explicitly pair it. Production migration/recovery UI remains outside this phase.

## Connection and Message Protocol

1. Scan the locally requested QR: `version`, `desktopServiceId`, `displayName`, `endpoint`, `certificateFingerprint`, `pairingToken`, and `expiresAt` (Unix milliseconds). The WSS endpoint must be a local IP address with path `/v1/channel`.
2. Discover `_orbit._tcp` using mDNS. Its TXT fields contain `version`, `id`, `name`, `endpoint`, `parts`, and `cert0` … `certN`: at most eight 200-character base64 chunks of the public DER certificate. No tokens, private keys, or credentials are advertised. Discovery is untrusted; verify SHA-256 against the QR pin before opening HTTPS/WSS or transmitting a credential.
3. Send bodyless `POST /v1/pair` over pinned HTTPS with `Authorization: Bearer <one-time-pairing-token>`. Success returns `version`, `desktopServiceId`, `deviceId`, and a durable `credential`. Invalid/expired/reused invitations return 401. A storage failure returns 503 and consumes the invitation; request a new local QR rather than retrying redemption.
4. Send bodyless `POST /v1/session` over pinned HTTPS with `Authorization: Bearer <durable-device-credential>`. Success returns `version`, `deviceId`, `sessionId`, `expiresAt`, and `sessionToken`. Responses use `Cache-Control: no-store`.
5. Connect to WSS with `Authorization: Bearer <session-token>`. Every command uses this verified connection identity. Credentials/tokens are never accepted in URLs or feature payloads. The old `session.refresh` command is rejected.
6. At 80% of the token's lifetime, or before sending another command after 3,000 submissions, the integration client automatically exchanges its durable credential and opens a replacement WSS connection with the new Authorization header. A disconnect follows bounded exponential backoff with jitter (500 ms base, 30 s cap). Failed authentication stops retries and requires explicit recovery. A bounded queue of 16 online requests lets Clipboard Sync and File Transfer share a socket fairly. Every queued request belongs to that socket and is discarded if the connection changes; no offline queue or command replay exists. In-flight commands interrupted by renewal/disconnection reject with an unknown outcome. File Transfer resumes by reconciling durable checkpoints.

TLS chain verification stays enabled. The public certificate that matches the QR fingerprint is the trust anchor, and each connection checks its stable service identity and fingerprint again. A changed discovery endpoint never changes the pin. React Native equivalents remain Phase 8.

Feature command envelope:

```json
{
  "version": 1,
  "type": "<module.command>",
  "requestId": "<UUID>",
  "payload": {}
}
```

Each handler will define its command names and validate its payload. Extra envelope fields, binary frames, malformed JSON, and unsupported versions are rejected. `session.*` is reserved for transport authentication and cannot be registered as a feature command.

Responses use the same version and request ID, with `type: "response"` and either `payload: { "ok": true, "result": ... }` or `payload: { "ok": false, "error": { "code": "..." } }`. A malformed envelope gets a null request ID. Error codes are defined in `src/protocol/errors.ts`; internal exceptions are never sent to the client.

Desktop events use `{ "version": 1, "type": "event", "requestId": null, "payload": { "eventType": "<module.event>", "data": ... } }`. Generic device events can use `transport.publish(deviceId, eventType, data)`. Clipboard Sync uses the transport-owned `context.connection.publish` capability instead: only the exact subscribed, currently authenticated socket receives its clipboard events. Another connection from the same paired device receives nothing until it subscribes. Events are not persisted or queued for offline devices.

Only one feature command executes at a time per socket; overlapping requests receive `BUSY`. Clients should await completion or coalesce input before sending another request. The router rejects duplicate request IDs for the lifetime of a session, including reconnects. This is not an exactly-once guarantee across session renewal or service restarts: never automatically resend a command whose outcome is unknown.

## Clipboard Sync

The service registers `clipboard.subscribe`, `clipboard.unsubscribe`, and `clipboard.write`. Native clipboard access starts lazily on the first subscription; service startup and ordinary paired connections do not read clipboard contents. Both sides poll every 500 ms while subscribed and serialize their native operations. Only the current value's keyed fingerprint is kept for change detection; no clipboard history is retained or persisted.

Windows runs one hidden, persistent PowerShell worker in an STA thread using .NET Windows Forms. Clipboard text travels over private stdin/stdout pipes, never shell arguments, environment variables, files, or Activity Log entries. Run the service in the signed-in user's interactive desktop session; a Session 0 Windows service does not share that clipboard.

Linux uses `wl-copy` / `wl-paste` from `wl-clipboard` on Wayland, or `xclip` on X11, always targeting the regular clipboard rather than the primary selection. Install the appropriate package using your distribution's package manager. `WAYLAND_DISPLAY` / `XDG_SESSION_TYPE` select Wayland; otherwise `DISPLAY` is required for X11. Missing tools or inaccessible displays return `CLIPBOARD_UNAVAILABLE`; Orbit never switches display systems to bypass a failure. The Linux tools retain the current selection in their clipboard-owner process until it is replaced, as required by the display protocol. This is not an Orbit history store.

Known image, rich-text, and file formats are ignored, even when accompanied by a plain-text representation. Oversized text is ignored rather than truncated. Empty text, Unicode, and original line endings are supported; embedded NUL and unpaired UTF-16 surrogates are rejected because they cannot be preserved across the native text formats. Clearing the clipboard to a non-text/absent selection does not clear the peer's clipboard. The peer only receives metadata for unsupported or oversized changes.

### Clipboard Protocol

All commands use the existing version 1 envelope and the session authenticated at the connection boundary. Payload objects are strict; extra fields, including credentials, are rejected.

| Command | Payload | Successful result |
| :--- | :--- | :--- |
| `clipboard.subscribe` | `{}` | `{ "subscriptionId": "<UUID>", "revision": 0 }` |
| `clipboard.unsubscribe` | `{ "subscriptionId": "<UUID>" }` | `{ "unsubscribed": true }` |
| `clipboard.write` | `{ "subscriptionId": "<UUID>", "baseRevision": 0, "text": "Orbit test" }` | `{ "status": "applied", "revision": 1 }` |

Revisions in these examples are illustrative. The desktop orders observed clipboard changes with a monotonically increasing revision for the running service. Subscribe returns the current revision and a fresh connection-scoped subscription ID, **never the current clipboard text**. Repeating subscribe on an already subscribed connection returns the same ID. Unsubscribe or disconnect invalidates it; an ID from another or previous connection returns `CLIPBOARD_NOT_SUBSCRIBED`.

Before a write, the desktop reads the OS clipboard again to observe local changes, compares `baseRevision` to its current revision, and rechecks the live connection/session immediately before the OS action. A stale write returns `{ "status": "conflict", "revision": <current> }` without changing the clipboard. Identical text returns `unchanged` without another OS write. An accepted change returns `applied` with the new revision and is not echoed back to its source connection. Conflict is a structured result, not an internal error; clients must inspect `status` even when the response envelope has `ok: true`.

Events use the existing event envelope, with these `payload` shapes:

```json
{"eventType":"clipboard.changed","data":{"subscriptionId":"<UUID>","revision":1,"text":"Orbit test"}}
{"eventType":"clipboard.status","data":{"subscriptionId":"<UUID>","revision":2,"status":"unsupported"}}
```

`clipboard.status` carries `unsupported`, `oversized`, or `unavailable`, with no text. An OS error emits `unavailable` and removes subscriptions; commands that encounter it return `CLIPBOARD_UNAVAILABLE`. The service/channel remain usable. Fix tool/display access and restart clipboard mode, or let the next connection renewal establish a new subscription. Unknown internal errors are never sent as diagnostics.

The integration client applies only newer events for its current subscription. It coalesces live events to the newest pending change and suppresses native echoes. If it observes a concurrent local copy, it preserves that local clipboard, reports `conflict`, and does not resend the text under a newer revision. Copy new text to sync again. Renewal and reconnect discard the old subscription, pending events, and local baseline; a fresh subscription establishes both baselines without sending prior or offline contents.

Polling can miss intermediate copies made within a polling interval, including copying the same text again. Revisions order changes observed by Orbit, not every native clipboard operation. Native APIs do not provide an atomic compare-and-write against other desktop applications: a local application can still change the clipboard between the final read and write. A disconnect after an OS write has started cannot roll it back; interrupted commands have an unknown outcome and are never replayed.

### Test Native Clipboard Access

Run this on each Windows/Linux desktop from `desktop/`. **It replaces the current clipboard with synthetic text**, checks Unicode, empty text, line endings, and the 8 KiB boundary, then leaves `Orbit Clipboard Sync native check passed.` on success. It prints no clipboard contents. It is separate from `npm test` and `test:lan`.

```powershell
npm.cmd run test:clipboard:native
```

On Linux use `npm run test:clipboard:native` in the active graphical session. Phase 3 Windows native writes and bidirectional sync were verified locally. **Linux Clipboard Sync remains unverified because no Linux machine was available.** Keep this as an open Phase 9 integration item; passing synthetic adapter tests does not verify native Linux behavior.

For live bidirectional testing, use two separate Windows/Linux desktops so they have independent OS clipboards. Start Orbit Desktop on one machine, bound to its private IPv4 address. Pair the other machine's integration client using a locally transferred, still-valid private pairing JSON file, as in the pairing instructions above. Then run on the client machine:

```powershell
npm.cmd run client -- clipboard
```

On Linux use `npm run client -- clipboard`. Wait for `Clipboard Sync: active` before copying. Verify:

1. Existing clipboard contents on both machines remain unchanged when the connection opens.
2. Copy a new short plain-text value in a plain-text editor on the client; paste it on the desktop. Repeat in the other direction. Status is metadata only: `sent` / `received`, with no repeated echo loop.
3. Copy an image, rich text, or more than 8 KiB of UTF-8 text. The peer's clipboard stays unchanged; new ignored changes report `unsupported` or `oversized`.
4. Leave the client open through renewal (about four minutes). It becomes `active` again without a QR scan or clipboard overwrite, then syncs fresh copies.
5. Stop the service, change both clipboards while disconnected, and restart it. Reconnection preserves both offline values. A new copy after `active` syncs normally.
6. Enter `quit` in the client. Subsequent desktop clipboard changes are not received. Restart clipboard mode to subscribe again.

The same-machine service/client setup remains useful for pairing and command tests but shares one OS clipboard, so it cannot prove independent bidirectional native sync. React Native and real-phone validation remain Phases 8 and 9.

## File Transfer

Files use the same paired WSS channel and version 1 envelope. Authentication comes from the live connection/session, never a payload credential. An authenticated paired device may upload into the dedicated desktop inbox. Downloads require a file selected locally in the desktop terminal, addressed to one paired device, and explicitly accepted by that client. There is no remote path request, filesystem browsing, automatic opening, or execution.

### File Protocol

The manifest is `{ transferId, direction, name, sizeBytes, sha256, chunkBytes }`: a UUID, `to-desktop` or `to-client`, a plain filename, integer byte length, lowercase hexadecimal SHA-256 of the whole file, and exactly `32768`. Names cannot contain paths, reserved Windows names, control characters, or trailing dots/spaces, and are limited to 200 UTF-8 bytes. UUIDs are normalized to lowercase. Payloads are strict Zod objects.

Each decoded chunk is 32 KiB, except the final chunk, which may be shorter. Empty files have no chunks. `dataBase64` must be canonical base64; offsets are sequential, zero-based byte offsets at chunk boundaries. Chunk and whole-file hashes must both match. Base64 chunks fit the existing 64 KiB envelope.

In the table, `ref` means `{ transferId }`, `lease` means `{ transferId, leaseId }`, and `status` means `{ manifest, state, nextOffset, leaseId?, error? }`. `nextOffset` is the durable acknowledged byte count; errors contain only a safe `FILE_*` code. The twelve commands below are the complete approved list (previously described as “ten”).

| Command | Payload | Successful result |
| :--- | :--- | :--- |
| `file.subscribe` | `{}` | `{ subscriptionId }`; future local offers only, no initial replay |
| `file.unsubscribe` | `{ subscriptionId }` | `{ unsubscribed: true }` |
| `file.offers` | `{ cursor? }` | `{ offers: Manifest[], nextCursor: UUID or null }`; owned pending downloads, at most 16 per page |
| `file.offer` | Upload manifest | `status`; idempotent for the same owner, ID, and manifest |
| `file.accept` | `ref` | `status`; accepts a download with an empty receiver checkpoint |
| `file.status` | `ref` | `status`; also returns retained terminal receipts |
| `file.resume` | `{ transferId, checkpoint? }` | `status`; creates a fresh connection-bound lease |
| `file.chunk` | `{ ...lease, offset, dataBase64, sha256 }` | `{ transferId, nextOffset, state }`; upload checkpoint after file flush and metadata save |
| `file.read` | `{ ...lease, offset }` | `{ transferId, offset, dataBase64, sha256 }`; one download chunk |
| `file.ack` | `{ ...lease, nextOffset, sha256 }` | `{ transferId, nextOffset, state }`; receiver confirms a durably stored download chunk |
| `file.finish` | `lease` | `status`; starts final verification, then poll status for the terminal receipt |
| `file.cancel` | `ref` | `status`; removes incomplete receiving data, preserves source and completed files |

Events use the existing event envelope. `file.offered` contains `{ subscriptionId, manifest }` and reaches only subscribed sockets of the selected paired device. `file.progress` contains `{ transferId, state, committedBytes, sizeBytes }` and reaches the exact live lease connection. Progress events are limited to four per second, with immediate state transitions; command responses always carry the current checkpoint. Neither event is persisted or replayed.

The normal state path is `offered → transferring ⇄ paused → verifying → completed`; `cancelled`, `failed`, and `expired` are terminal. Download acceptance/resume also uses `verifying` while checking the selected source and receiver prefix, then becomes `transferring`. Disconnect invalidates the lease and pauses incomplete work. A new lease cannot be used by an old socket or another paired device. Final verification rechecks authorization before publishing a received file.

Upload resume omits `checkpoint` and uses the desktop's durable offset. Download resume requires `{ receivedBytes, prefixSha256 }`, calculated from the client's durable partial file. The desktop verifies that prefix against its selected source, then reconciles its acknowledgement to the receiver's offset. Bytes written after the last durable checkpoint are truncated on restart. A source that no longer matches its manifest fails verification. Matching repeated chunks are acknowledged; conflicting duplicates fail. A lost final response is recovered through `file.status`, without retransmitting a completed upload or needing its original source.

### Storage and Limits

The desktop inbox defaults to `.local/service/received`; the integration client's inbox is `.local/client/received`. `ORBIT_RECEIVE_DIR` can select a dedicated owner-only desktop inbox before startup. Keep it on a filesystem that supports hard links (for example NTFS or a normal Linux filesystem); publishing uses an atomic link that refuses to overwrite an existing destination. Unsupported filesystems fail with `FILE_IO`; there is no overwrite fallback.

Final files are named `<transferId>-<name>`. Incomplete receiving files are `.<transferId>.part` in the same inbox; strict JSON checkpoints live in the private `transfers/` directory. The checkpoints contain transfer metadata and, for locally selected sources, their local path. These are transfer state, not Activity Log entries. Data directories must remain private. Run only one integration client against each client directory.

Limits are 1 GiB per file, one nonterminal transfer per paired device, four nonterminal transfers service-wide, and 4 GiB reserved for incomplete receiving data. Offered and paused transfers count toward these limits. Reservations use the declared file size; orphan partial bytes also count until cleanup. Completed files are outside the incomplete-data quota and remain in the inbox until the user manages them.

Incomplete transfers expire after 24 hours without checkpoint activity. Terminal receipts remain for 24 hours after their terminal transition. Cleanup runs while the service/client is open and on startup; it removes managed incomplete files and expired checkpoints, never source files or completed inbox files. Orphan partials from a crash before checkpoint creation expire after 24 hours too. Activity Log remains in memory and contains no filenames, paths, hashes, or file contents.

### Test File Transfer Locally

Run the automated checks from `desktop/`:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:lan
```

Start the service and pair once using the instructions above. With an existing pairing, simply run `npm.cmd start` in the service terminal. In the client terminal run:

```powershell
npm.cmd run client -- files
```

This mode does not access the native clipboard. To exercise both features on separate desktop machines, use `npm.cmd run client -- files --clipboard`. The client prints its paired device ID and metadata-only transfer status. On Linux use `npm` instead of `npm.cmd`.

Create a synthetic file in a third PowerShell terminal, from `desktop/`:

```powershell
[System.IO.File]::WriteAllBytes("$PWD/.local/file-transfer-test.bin", (New-Object byte[] 16777217))
Get-FileHash .local/file-transfer-test.bin -Algorithm SHA256
```

In the running client, enter the following JSON (the path is local to that client; relative paths resolve from `desktop/`):

```json
{"type":"upload","path":".local/file-transfer-test.bin"}
```

Wait for `completed`, then compare hashes in the service terminal's directory using a separate shell:

```powershell
Get-FileHash .local/service/received/*-file-transfer-test.bin -Algorithm SHA256
```

For a download, select the file in the running **desktop service** terminal. Replace the device ID with the one printed by the files client:

```json
{"type":"file.offer","deviceId":"<paired-device-UUID>","path":".local/file-transfer-test.bin"}
```

The service prints a transfer UUID. In the running **client**, list offers and explicitly accept that UUID:

```json
{"type":"offers"}
{"type":"download","transferId":"<transfer-UUID>"}
```

After `completed`, run `Get-FileHash .local/client/received/*-file-transfer-test.bin -Algorithm SHA256` and compare with the original. For a LAN test, use each machine's own local paths and bind the service to its private IPv4 address as described above.

During a larger transfer, enter `quit` in the service and restart it, or stop/restart the files client with the same private directory. Expect checkpoint reconciliation followed by completion with the same UUID and matching hash. To request reconciliation explicitly, enter `{"type":"resume","transferId":"<transfer-UUID>"}`. To cancel an incomplete transfer, enter `{"type":"cancel","transferId":"<transfer-UUID>"}`; its receiving partial disappears while its source remains. Repeated tests create separate UUID-prefixed final files instead of overwriting previous results.

Phase 4 uploads, downloads, hash comparison, cancellation, restart-resume, and Clipboard Sync during transfer were verified locally on Windows. React Native remains Phase 8; real-phone validation, native Linux Clipboard Sync, and real Linux File Transfer verification remain open for Phase 9.

## App Launcher

The service registers `launcher.list` and `launcher.launch`. Discovery starts only when requested. Both commands require the live paired session and use the existing version 1 envelope; payloads cannot carry credentials, filesystem paths, URLs, arguments, or shell commands. There are no scenes, custom commands, icons, or grid settings in this phase.

### Discovery and Native Activation

Windows lists current-user Start menu registrations through `Get-StartApps` and Windows Shell's AppsFolder. Unregistered portable executables do not appear. PowerShell runs hidden in an STA thread; selected registration data travels through stdin as JSON and is never interpolated into script text. The helper rechecks the registration, then waits for Orbit to recheck the connection/session before invoking the Shell `open` verb. Orbit does not request elevation or bypass an OS prompt. Run the service in the signed-in user's interactive desktop session. See [Microsoft's registration documentation](https://learn.microsoft.com/en-us/windows/configuration/store/find-aumid).

Linux reads `applications/` under `XDG_DATA_HOME` (default `~/.local/share`) and the absolute directories in `XDG_DATA_DIRS` (default `/usr/local/share:/usr/share`). It respects desktop-file ID precedence, `Hidden`, `NoDisplay`, `OnlyShowIn`, `NotShowIn`, `TryExec`, localized names, and `Terminal=true` exclusions. Only `Type=Application` entries are eligible. Hidden or invalid user overrides mask lower-priority registrations. Ambiguous duplicate IDs in one root are omitted. File symlinks are resolved and fingerprinted to support exported application registrations; directory symlinks are not traversed. See the [Desktop Entry specification](https://specifications.freedesktop.org/desktop-entry/latest-single/).

Linux requires `gio` with its `launch` subcommand, plus access to the active graphical session (`DISPLAY` or `WAYLAND_DISPLAY`, and the session bus where required by the application). Check `gio version` and `gio help launch` locally. GIO handles the selected registration's Exec/activation semantics; Orbit does not expand an Exec string or invoke a command shell. Missing tools/session access return `LAUNCHER_UNAVAILABLE`, with no alternate launcher fallback. No npm dependencies were added.

### Launcher Protocol

| Command | Payload | Successful result |
| :--- | :--- | :--- |
| `launcher.list` | `{ "cursor": "<optional continuation>" }`, or `{}` for a fresh catalog | `{ "catalogRevision": "<UUID>", "apps": [{ "appId": "<opaque ID>", "name": "App name" }], "nextCursor": "<continuation or null>" }` |
| `launcher.launch` | `{ "appId": "<opaque ID>", "catalogRevision": "<UUID>" }` | `{ "status": "requested" }` |

Each page contains at most 32 apps, with a maximum catalog of 2,048. Names are bounded to 256 UTF-8 bytes and contain no control characters. Cursors identify a revision and page offset; use the returned value unchanged. A fresh list and each launch re-enumerate registrations. Changes invalidate the revision; `LAUNCHER_STALE_CATALOG` means list again and select from the new result. Continuation pages refer to the in-memory snapshot, with another revalidation before activation.

Opaque IDs are derived with a service-instance secret and reveal no native path or AppID. They remain stable while a registration's identity and service instance remain unchanged; restart requires a fresh list. The catalog and secret are memory-only. The native adapter checks the selected registration again before activation, and Orbit rechecks authorization immediately before handing off to the OS.

`requested` means the native activation request returned successfully; it does not prove a visible window opened or gained focus. An application may reuse an existing window, show an OS prompt, or fail after activation. The OS handoff is not transactional: a registration can change after the final check, and a disconnect after handoff cannot undo activation. Interrupted or timed-out launches have an unknown outcome and are never replayed automatically, including after session renewal. Inspect the desktop before deciding whether to launch again.

Other safe errors are `LAUNCHER_NOT_FOUND`, `LAUNCHER_UNAVAILABLE`, `LAUNCHER_LIMIT`, and `LAUNCHER_UNKNOWN_OUTCOME`. Native stderr and exceptions are never returned. Activity Log contains only the existing command metadata and outcome; no app names, native IDs, paths, or arguments are logged.

Native helpers have an eight-second deadline and 2 MiB output cap. The integration client allows 20 seconds for a launcher command because launch includes discovery and activation checks. Native work is serialized service-wide; overlapping launcher operations return `BUSY`. The shared socket's other commands wait in its bounded online scheduler during a launcher request. Linux additionally bounds scans to 8,192 directory items, eight nested directory levels, and 64 KiB per desktop entry. Exceeding the scan/catalog bounds fails explicitly rather than returning a silently truncated catalog.

### Test App Launcher Locally

From `desktop/`, run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:lan
```

Use the existing service identity and pairing. Start the service in one terminal with `npm.cmd start`; in another run:

```powershell
npm.cmd run client -- launcher
```

In the running client, enter:

```json
{"type":"list"}
```

Wait for `App catalog ready`, then choose a harmless installed app from the displayed names and copy its opaque `appId`:

```json
{"type":"launch","appId":"<ID from the list>"}
```

Expect `Launch requested` and verify the app on the desktop. Launch an ordinary desktop app and, on Windows, a Store app if one is available. App names/IDs are shown for selection in this harness, not written to Activity Log. Enter `quit` to stop the client. On Linux use `npm` instead of `npm.cmd` and run in the active desktop session.

To check coexistence, run `npm.cmd run client -- launcher --clipboard`, wait for `Clipboard Sync: active`, copy new plain text between two desktops, and request a launch. A native launcher command may delay queued clipboard commands for several seconds. File Transfer coexistence is covered by the WSS integration test using synthetic activation.

After installing/removing an app or editing a test registration, try an old selection: expect `LAUNCHER_STALE_CATALOG`; enter `list` again. After service restart or automatic session renewal, list again before selecting an app. Disconnect during a launch and confirm reconnection does not repeat it; inspect the desktop for an uncertain first outcome.

Read-only Windows discovery and native preparation can be checked without opening apps; successful visible activation still requires the manual check above. Native Linux App Launcher, Clipboard Sync, and File Transfer remain open verification items for Phase 9. Icons/grid customization and Orbit Mobile remain Phase 8.

## Input Simulation

Phase 6 begins with the control-session guard in `src/input-simulation/control-session.ts`. This is an internal module tested with synthetic adapters. It is not registered with the Command Router or wired into the desktop service yet; there are no live `input.begin` / `input.events` commands or native input backends in this step.

The guard reserves one controlling connection before awaiting biometric verification. The default verifier denies access before creating an adapter. A verified session belongs to the exact transport connection and authenticated device/session identity. Native setup begins only after verification; event batches require strictly increasing sequence numbers starting at 1 and execute one at a time. A partly applied or interrupted batch is never replayed. Keepalive and end use the existing verified control session without asking for another biometric confirmation. A replacement WSS connection requires a new control session and fresh verification.

Disconnect and shutdown invalidate control immediately. Expiry and revocation are checked before operations and every 100 ms while a reservation exists. Once native setup completes, an explicit keepalive is required within five seconds; event traffic does not extend that deadline. Expired keepalives cannot resurrect control. The guard aborts pending work, waits for it to settle, releases the adapter's held inputs, and disposes its resources. Cleanup is idempotent and disposal is attempted even if release rejects.

Cleanup has a five-second deadline. Failure or timeout disables further control for that guard instance until the service is restarted and records only `input.release_failed` metadata. A pending operation that settles later still runs its cleanup; it never restores control. This does not guarantee physical key release if the native process or OS hangs. The upcoming adapters must stop input after abort, bound native operations, track only their own held keys/buttons, and provide their own cleanup guarantees. Native platform verification remains outstanding.

Run the guard tests from `desktop/` without generating physical input:

```powershell
npm.cmd run build
node --test dist/test/input-control-session.test.js
```

The next Phase 6 step is native adapter implementation and failure-path testing, followed by command/service/client wiring. The production biometric hook remains default-deny; this module adds no runtime bypass.

## Security & Activity Log

- **LAN-only** — no APNs/FCM, cloud routes, analytics, or telemetry. Native requests carrying a browser Origin are rejected.
- **Sensitive actions** — every `input.*` and `power.*` command passes through the biometric-confirmation hook. The default verifier denies execution. Input Simulation will require confirmation once per remote-control session; Power & Session will require confirmation per action. Neither policy's actual verifier/UI is implemented in Phase 2, and a client-provided boolean is not proof.
- **Pairing contract** — `src/protocol/pairing.ts` validates the approved QR and response shapes with Zod. The private service identity and credential hashes persist; invitations and session tokens do not survive a service restart.
- **Per-device permission scoping** remains v2. All registered nonsensitive v1 commands are available to an authenticated paired device. Restart power control, Panic Lock, and clipboard history are not implemented.
- **Activity Log** stores only timestamp, severity, event type, device/session identifiers, request ID, registered command type, and outcome. It has no persistence, payload fields, arbitrary error strings, or network export. The last 1,000 entries are held in memory to bound RAM usage; this is not a disk retention policy.

Operational limits are named in `src/config.ts`, `session-auth.ts`, and the transport/router modules: five-minute sessions, 30-second heartbeats, 64 KiB incoming messages, 256 KiB outbound buffering, 32 WebSocket connections, eight sessions per device, and 128 sessions total. A missed heartbeat terminates the peer. Expiry/revocation closes the socket with code `4001`; shutdown uses `1001` and a bounded close grace period. A new session beyond a device's eight-session limit invalidates its oldest session.

Session issuance and upgrade attempts are limited to 60 per peer IP per minute. The router remembers up to 4,096 request IDs per session and then returns `BUSY` until the client renews its session. The integration client renews proactively at 3,000 submitted commands; File Transfer reconciles checkpoints on the replacement connection.
