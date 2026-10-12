# Phone transport and certificate pinning

The phone talks to Orbit Desktop over HTTPS and WSS to a self-signed certificate. Trust comes only from the pairing QR, which carries the SHA-256 fingerprint of that certificate. The phone never trusts a system CA for the desktop and never falls back to unpinned TLS.

## Layers

| Layer | Where | Tested |
| --- | --- | --- |
| `mobile/core` pairing, session, agent API | pure TypeScript, no platform imports | Node unit tests with a fake transport |
| `PinnedTransport` interface (`core/src/transport.ts`) | the only platform seam | contract documented below |
| Node adapter | `mobile/e2e/test/node-pinned-transport.ts` | e2e against the real desktop |
| Native adapter (Expo module) | `mobile/app/modules/orbit-pinned-transport` | on a real phone (needs a development build) |

## Why a native module

Expo Go and React Native's built-in `fetch` and `WebSocket` cannot pin a certificate or accept a self-signed one. A small local Expo module is needed:

- Android (Kotlin): OkHttp with a custom `X509TrustManager` that accepts exactly the leaf certificate whose SHA-256 equals the pin. OkHttp also supplies the `Authorization` header on the WebSocket upgrade.
- iOS (Swift): `URLSession` with a delegate that answers the server-trust challenge by comparing the SHA-256 of the leaf certificate with the pin, and `URLSessionWebSocketTask` for the channel.

Consequence: the app runs as an Expo development build or a release build, not in Expo Go.

## Contract every adapter must meet

1. Compare the pin to the SHA-256 of the presented leaf certificate, lowercase hex, before sending any header or body. On mismatch, fail and send nothing.
2. `postCredential` sends `POST` with `Authorization: Bearer <token>` and an empty body. Status 401 rejects with `AuthenticationRejected`. Any other non-200 status rejects.
3. `openChannel` sends the session token in the `Authorization` header of the upgrade request and does not follow redirects.
4. Text frames only. Maximum message size 64 KiB.
5. Never log tokens or certificates.

## Storage

The paired record (`PairedDesktop`) holds the long-lived credential. It goes in the OS secure store (Keychain on iOS, Keystore-backed storage on Android) and nowhere else.
