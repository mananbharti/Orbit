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

export interface PinnedTransport {
  /** POST with a Bearer token and empty body to /v1/pair or /v1/session. Resolves parsed JSON. 401 must reject with AuthenticationRejected. A pin mismatch must reject and never fall back. */
  postCredential(trust: PinnedTrust, path: '/v1/pair' | '/v1/session', token: string, signal?: AbortSignal): Promise<unknown>;
  /** Opens wss to trust.endpoint with Authorization: Bearer <sessionToken>, pinned to trust.certificateFingerprint. */
  openChannel(trust: PinnedTrust, sessionToken: string, handlers: ChannelHandlers): Channel;
}
