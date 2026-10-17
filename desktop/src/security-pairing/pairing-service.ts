/** Opens explicit one-use pairing windows; depends on a durable store and identity; does not trust discovery or authenticate commands. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PairingPayload } from '../protocol/pairing.js';
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { FilePairedCredentialStore } from './paired-credential-store.js';
import { credentialHash, TOKEN_PATTERN } from './session-auth.js';
import type { Scope } from './scopes.js';

export const PAIRING_TTL_MS = 120_000;
type PublicIdentity = Pick<PairingPayload, 'desktopServiceId' | 'displayName' | 'endpoint' | 'certificateFingerprint' | 'macAddresses'>;

export class PairingService {
  private invitation?: { hash: Buffer; expiresAt: number; scopes?: readonly Scope[] };
  constructor(private readonly identity: PublicIdentity, private readonly store: FilePairedCredentialStore,
    private readonly log: ActivityLog, private readonly now = Date.now) {}

  /** scopes limits what the paired phone may do; undefined grants full access. */
  open(scopes?: readonly Scope[]): PairingPayload {
    const pairingToken = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.invitation = { hash: Buffer.from(credentialHash(pairingToken), 'hex'), expiresAt, ...(scopes ? { scopes } : {}) };
    this.log.record({ severity: 'info', eventType: 'pairing.opened', outcome: 'success' });
    return { version: 1, desktopServiceId: this.identity.desktopServiceId, displayName: this.identity.displayName,
      endpoint: this.identity.endpoint, certificateFingerprint: this.identity.certificateFingerprint, pairingToken, expiresAt,
      ...(this.identity.macAddresses?.length ? { macAddresses: this.identity.macAddresses } : {}) };
  }

  close(): void { this.invitation = undefined; }

  redeem(token: string) {
    const invitation = this.invitation;
    if (!invitation || invitation.expiresAt <= this.now() || !TOKEN_PATTERN.test(token)
      || !timingSafeEqual(invitation.hash, Buffer.from(credentialHash(token), 'hex'))) {
      this.log.record({ severity: 'warn', eventType: 'pairing.rejected', outcome: 'rejected' });
      return undefined;
    }
    // Consume synchronously before disk I/O; concurrent redemption and failed writes cannot reuse the QR.
    this.invitation = undefined;
    const device = this.store.enroll(invitation.scopes);
    this.log.record({ severity: 'info', eventType: 'pairing.completed', deviceId: device.deviceId, outcome: 'success' });
    return { version: 1, desktopServiceId: this.identity.desktopServiceId, ...device };
  }
}
