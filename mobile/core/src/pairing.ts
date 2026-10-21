/** Redeems a scanned QR exactly once; depends on the pinned transport; does not retry enrollment or persist anything. */
import { pairedResponseSchema, pairingPayloadSchema, type PairedDesktop } from './protocol.js';
import { AuthenticationRejected, explainTransportFailure, TransportError, type PinnedTransport } from './transport.js';

export class PairingError extends Error {
  constructor(readonly reason: 'invalid-qr' | 'expired' | 'rejected' | 'mismatch', message: string) { super(message); }
}

/** Accepts the raw QR text (JSON). Returns the record to store in the secure store. */
export async function pairWithQr(qrText: string, transport: PinnedTransport, now: () => number = Date.now): Promise<PairedDesktop> {
  let raw: unknown;
  try { raw = JSON.parse(qrText); } catch { throw new PairingError('invalid-qr', 'This is not an Orbit pairing code'); }
  const parsed = pairingPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new PairingError('invalid-qr', 'This is not an Orbit pairing code');
  const qr = parsed.data;
  if (qr.expiresAt <= now()) throw new PairingError('expired', 'This pairing code has expired. Show a new one on your computer');
  let response: unknown;
  try {
    response = await transport.postCredential({ desktopServiceId: qr.desktopServiceId, endpoint: qr.endpoint,
      certificateFingerprint: qr.certificateFingerprint }, '/v1/pair', qr.pairingToken);
  } catch (error) {
    if (error instanceof AuthenticationRejected) throw new PairingError('rejected', 'The computer did not accept this code. It may have been used already. Show a new one.');
    const detail = error instanceof TransportError ? error.detail : undefined;
    throw new PairingError('rejected', explainTransportFailure(error instanceof TransportError ? error.kind : 'unknown') + (detail ? ` (${detail})` : ''));
  }
  const result = pairedResponseSchema.safeParse(response);
  if (!result.success || result.data.desktopServiceId !== qr.desktopServiceId) {
    throw new PairingError('mismatch', 'The computer answered with an unexpected identity');
  }
  return { desktopServiceId: qr.desktopServiceId, displayName: qr.displayName, deviceId: result.data.deviceId,
    endpoint: qr.endpoint, certificateFingerprint: qr.certificateFingerprint, credential: result.data.credential,
    ...(qr.macAddresses?.length ? { macAddresses: qr.macAddresses } : {}) };
}

/** Reads just the desktop identity out of a scanned code, before anything is redeemed. Undefined when the text is not a recognizable Orbit code; pairWithQr gives the full error. */
export function peekPairingDesktopId(qrText: string): string | undefined {
  try {
    const parsed = pairingPayloadSchema.safeParse(JSON.parse(qrText));
    return parsed.success ? parsed.data.desktopServiceId : undefined;
  } catch { return undefined; }
}
