# Browser tab control (row 18) - design

Goal: from the phone, see the computer's browser tabs, switch to one, close one, open a URL. Real implementation, no cloud: a companion Chrome/Edge extension talks to the desktop app over a loopback-only channel; the phone talks to the desktop through the normal Orbit protocol.

## Pieces

### 1. Extension (`extension/`)
- MV3, loadable unpacked (chrome://extensions -> developer mode). No store review needed.
- `manifest.json`: permissions `tabs`, `storage`; host permissions none; background service worker `background.js`; options page `options.html` + `options.js`.
- `background.js`: connects to `ws://127.0.0.1:<port>` with the token as `?token=`; answers JSON messages `{id, type: 'list'|'open'|'close'|'activate', ...}` using chrome.tabs; reconnects with backoff (2s, 5s, 15s, 60s cap); badge dot = connected.
- `options.html/js`: one-time setup: paste port + token (shown in the desktop app Settings), save to chrome.storage.local, test connection button with a clear ok/error line.

### 2. Desktop loopback channel (`desktop/src/browser-tabs/`)
- `extension-server.ts`: plain `ws` server bound to 127.0.0.1 only (never 0.0.0.0), random port persisted in the service directory's private JSON, random 24-char token persisted alongside. First message must carry the token or the socket closes. Request/response ids, 5s timeout per request.
- `tabs-service.ts`: registers `tabs.list`, `tabs.open` ({url}), `tabs.close` ({tabId}), `tabs.activate` ({tabId}) with the command registry; unregisters in stop(). If no extension is connected: ProtocolError `tabs.extension_offline` (mirrored in all four error-code places). `tabs.status` -> {connected: bool, browser?: string} for the phone UI.
- Settings surface in the desktop shell shows port + token + a copy button and whether an extension is connected.

### 3. Protocol
- `desktop/src/protocol/tabs.ts`: zod schemas: tabId = number, open = {url: https?://...}, responses {tabs: [{id, title, url, active, windowId}]}.
- Error codes: `tabs.extension_offline`, `tabs.not_found` (tab id gone), mirrored in desktop protocol/errors.ts, integration-client/orbit-client.ts, mobile/core protocol.ts, messages.ts.

### 4. Phone UI (`mobile/app/src/screens/TabsScreen.tsx`)
- Home chip "Browser tabs" (Icon.tsx needs a new path). Screen: pull-to-refresh list of tabs grouped by window, tap = activate on the PC, swipe/press X = close, plus an "Open link" field that pastes from the phone clipboard by default. Extension-offline state: friendly card explaining setup in three steps with the docs link.
- mobile/core: `tabs.ts` API wrapper (list/open/close/activate/status), subscribe pattern like other APIs.

### 5. Tests
- Desktop unit: extension-server auth (bad token closes, good token answers), tabs-service command validation + offline error, request timeout.
- Extension: none in CI (no browser); manual steps in TESTING.md.
- E2E: tabs.* over paired session with a fake extension client on the loopback port.

### 6. Honest limits (ACCEPTANCE row 18)
- Chrome/Edge/Brave (MV3). Firefox needs a tiny manifest variant (document). Safari not supported (document).
- Extension is user-installed unpacked; desktop shows the token. Real-device verification pending; TESTING step 24.

## Build order
1. extension-server + tabs-service + protocol schemas + error codes (4 places) + desktop tests.
2. mobile/core tabs.ts + TabsScreen + Home chip + Icon path + preview mock + dump-dom verify.
3. extension/ files + README section.
4. ACCEPTANCE row 18 + TESTING step 24. Commit, push, CI, milestone.
