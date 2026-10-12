/** Persists credentials authorized by pairing; depends on private atomic storage; does not decide whether enrollment is allowed. */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { atomicWrite } from './atomic-file.js';
import { IDENTIFIER_PATTERN, isRecord } from '../protocol/validation.js';
import { credentialHash, type PairedCredentialStore } from './session-auth.js';
import { SCOPES, type Scope } from './scopes.js';

export class FilePairedCredentialStore implements PairedCredentialStore {
  private readonly devices = new Map<string, string>();
  private readonly scopes = new Map<string, readonly Scope[]>();

  constructor(private readonly path?: string) {
    // No provisioning file means no authorized devices, never an authentication bypass.
    if (!path || !existsSync(path)) return;
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(data) || data.length > 128) throw new Error('Invalid paired credential store');
    const ids = new Set<string>();
    for (const entry of data) {
      const hasScopes = isRecord(entry) && 'scopes' in entry;
      if (hasScopes && (!Array.isArray(entry.scopes) || entry.scopes.length < 1 || entry.scopes.some(s => !(SCOPES as readonly unknown[]).includes(s)))) {
        throw new Error('Invalid paired credential store');
      }
      if (!isRecord(entry) || Object.keys(entry).length !== (hasScopes ? 3 : 2)
        || typeof entry.deviceId !== 'string' || !IDENTIFIER_PATTERN.test(entry.deviceId)
        || typeof entry.credentialHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.credentialHash)
        || this.devices.has(entry.credentialHash) || ids.has(entry.deviceId)) {
        throw new Error('Invalid paired credential store');
      }
      ids.add(entry.deviceId);
      this.devices.set(entry.credentialHash, entry.deviceId);
      if (hasScopes) this.scopes.set(entry.deviceId, Object.freeze([...new Set(entry.scopes as Scope[])]));
    }
  }

  verify(credential: string): string | undefined { return this.devices.get(credentialHash(credential)); }
  scopesOf(deviceId: string): readonly Scope[] | undefined { return this.scopes.get(deviceId); }
  isActive(deviceId: string): boolean { return [...this.devices.values()].includes(deviceId); }

  /** Paired devices for the owner's `devices` listing; never includes credentials or hashes. */
  list(): { deviceId: string; scopes: readonly Scope[] | 'all' }[] {
    return [...this.devices.values()].map(deviceId => ({ deviceId, scopes: this.scopes.get(deviceId) ?? 'all' }));
  }

  /** Unpairs one device. The file is rewritten first; the device stops working on its next request. Returns false for an unknown id. */
  revoke(deviceId: string): boolean {
    if (!this.path || ![...this.devices.values()].includes(deviceId)) return false;
    const kept = [...this.devices].filter(([, id]) => id !== deviceId);
    atomicWrite(this.path, JSON.stringify(kept.map(([credentialHash, id]) => ({ credentialHash, deviceId: id,
      ...(this.scopes.has(id) ? { scopes: this.scopes.get(id) } : {}) }))));
    for (const [hash, id] of [...this.devices]) if (id === deviceId) this.devices.delete(hash);
    this.scopes.delete(deviceId);
    return true;
  }

  /** scopes undefined grants full access. */
  enroll(scopes?: readonly Scope[]): { deviceId: string; credential: string } {
    if (!this.path || this.devices.size >= 128) throw new Error('Pairing store unavailable');
    const credential = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    const hash = credentialHash(credential);
    const entries = [...this.devices].map(([credentialHash, deviceId]) => ({ credentialHash, deviceId,
      ...(this.scopes.has(deviceId) ? { scopes: this.scopes.get(deviceId) } : {}) }));
    const unique = scopes ? [...new Set(scopes)] : undefined;
    // Publish in memory only after the durable replacement succeeds.
    atomicWrite(this.path, JSON.stringify([...entries, { deviceId, credentialHash: hash, ...(unique ? { scopes: unique } : {}) }]));
    this.devices.set(hash, deviceId);
    if (unique) this.scopes.set(deviceId, Object.freeze(unique));
    return { deviceId, credential };
  }
}
