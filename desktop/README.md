# Orbit Desktop

The Node.js + TypeScript background service for Orbit. Phases 1–2 provide the **Command Router**, **WebSocket** encrypted command channel, **QR Code Pairing**, durable device credentials, automatic session renewal, mDNS/Bonjour discovery, and an in-memory **Activity Log**. A TypeScript integration client exercises the channel while Orbit Mobile remains a later phase.

Phase 3 adds **Clipboard Sync**: bidirectional Unicode plain text, up to 8 KiB in UTF-8, through authenticated connection-scoped subscriptions. Windows and Linux adapters are wired into the service and TypeScript integration client. File Transfer, App Launcher, Input Simulation, Power & Session, and Orbit Mobile remain later phases. The root [README](../README.md) remains the product scope reference.

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

`test:lan` additionally exercises real mDNS multicast discovery followed by pinned HTTPS pairing, authenticated WSS, and bidirectional Clipboard Sync with synthetic OS adapters. It needs multicast access on the host; a sandbox or firewall blocking UDP 5353 causes a failure, not a skipped test. These are desktop/Node tests, not real-phone validation.

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
6. At 80% of the token's lifetime, the integration client automatically exchanges its durable credential and opens a replacement WSS connection with the new Authorization header. A disconnect follows bounded exponential backoff with jitter (500 ms base, 30 s cap). Failed authentication stops retries and requires explicit recovery. No commands are queued or replayed. In-flight commands interrupted by renewal/disconnection reject with an unknown outcome.

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

On Linux use `npm run test:clipboard:native` in the active graphical session. Native Windows writes and Linux desktop behavior require local verification; passing synthetic adapter tests does not verify those OS integrations.

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

## Security & Activity Log

- **LAN-only** — no APNs/FCM, cloud routes, analytics, or telemetry. Native requests carrying a browser Origin are rejected.
- **Sensitive actions** — every `input.*` and `power.*` command passes through the biometric-confirmation hook. The default verifier denies execution. Input Simulation will require confirmation once per remote-control session; Power & Session will require confirmation per action. Neither policy's actual verifier/UI is implemented in Phase 2, and a client-provided boolean is not proof.
- **Pairing contract** — `src/protocol/pairing.ts` validates the approved QR and response shapes with Zod. The private service identity and credential hashes persist; invitations and session tokens do not survive a service restart.
- **Per-device permission scoping** remains v2. All registered nonsensitive v1 commands are available to an authenticated paired device. Restart power control, Panic Lock, and clipboard history are not implemented.
- **Activity Log** stores only timestamp, severity, event type, device/session identifiers, request ID, registered command type, and outcome. It has no persistence, payload fields, arbitrary error strings, or network export. The last 1,000 entries are held in memory to bound RAM usage; this is not a disk retention policy.

Operational limits are named in `src/config.ts`, `session-auth.ts`, and the transport/router modules: five-minute sessions, 30-second heartbeats, 64 KiB incoming messages, 256 KiB outbound buffering, 32 WebSocket connections, eight sessions per device, and 128 sessions total. A missed heartbeat terminates the peer. Expiry/revocation closes the socket with code `4001`; shutdown uses `1001` and a bounded close grace period. A new session beyond a device's eight-session limit invalidates its oldest session.

Session issuance and upgrade attempts are limited to 60 per peer IP per minute. The router remembers up to 4,096 request IDs per session and then returns `BUSY` until the client renews its session. File Transfer will define chunk sizing below the message limit when that module is built.
