/** The only platform-specific seam: certificate-pinned HTTPS and WSS. Implemented natively on the phone, faked in tests. */
export interface PinnedTrust {
  desktopServiceId: string;
  endpoint: string;
  /** Lowercase hex SHA-256 of the desktop leaf certificate, taken from the scanned QR. */
  certificateFingerprint: string;
}

export interface ChannelHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(): void;
}
export interface Channel { send(text: string): void; close(): void }

export class AuthenticationRejected extends Error {
  constructor() { super('Desktop rejected authentication; explicit re-pairing may be required'); }
}

export type TransportFailure = 'pin-mismatch' | 'timeout' | 'refused' | 'unreachable' | 'local-network-denied' | 'desktop-refused' | 'unknown';
/** A network-level failure classified by the native layer so the UI can say what actually went wrong. */
export class TransportError extends Error {
  /** detail is a short technical hint (native error code or HTTP status) shown to help debugging; never contains secrets. */
  constructor(readonly kind: TransportFailure, readonly detail?: string) { super(`Transport failure: ${kind}`); }
}
/** Plain-language explanation for each failure kind. Shared by pairing and reconnection. */
export function explainTransportFailure(kind: TransportFailure): string {
  switch (kind) {
    case 'pin-mismatch': return 'This is not the computer from the pairing code (security check failed). Show a fresh code on your own computer.';
    case 'timeout': return 'Your computer did not answer. It may be on a different Wi-Fi, or this network stops devices from seeing each other (common on campus and hostel Wi-Fi). Try a phone hotspot.';
    case 'refused': return 'Your computer is reachable but Orbit is not listening at that address. Make sure Orbit is running on it.';
    case 'local-network-denied': return 'iPhone is blocking Orbit from your local network. Open Settings, then Orbit, and turn on Local Network.';
    case 'desktop-refused': return 'Your computer answered but refused the pairing. Show a fresh code in Orbit on your computer and scan it again.';
    case 'unreachable': return 'Cannot reach your computer. Check that both devices are on the same Wi-Fi.';
    default: return 'Could not pair. Check that both devices are on the same network';
  }
}

export interface PinnedTransport {
  /** POST with a Bearer token and empty body to /v1/pair or /v1/session. Resolves parsed JSON. 401 must reject with AuthenticationRejected. A pin mismatch must reject and never fall back. */
  postCredential(trust: PinnedTrust, path: '/v1/pair' | '/v1/session', token: string, signal?: AbortSignal, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Opens wss to trust.endpoint with Authorization: Bearer <sessionToken>, pinned to trust.certificateFingerprint. */
  openChannel(trust: PinnedTrust, sessionToken: string, handlers: ChannelHandlers): Channel;
}
