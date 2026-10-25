/** Supplies isolated test identities and handlers; depends on selfsigned and core modules; never provisions production devices. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { CommandRouter } from '../src/command-router/command-router.js';
import type { BiometricConfirmation } from '../src/security-pairing/biometric-confirmation.js';
import { SessionAuth } from '../src/security-pairing/session-auth.js';
import { loadEncryptedChannel } from '../src/transport/websocket/encrypted-channel.js';
import { generate } from 'selfsigned';

export function core(options: { ttlMs?: number; now?: () => number; biometric?: BiometricConfirmation;
    scopes?: Map<string, readonly import('../src/security-pairing/scopes.js').Scope[]> } = {}) {
  const deviceId = randomUUID();
  const credential = randomBytes(32).toString('base64url');
  const log = new ActivityLog();
  let active = true;
  const pairedDevices = new Map<string, string>([[credential, deviceId]]);
  const auth = new SessionAuth({ verify: token => pairedDevices.get(token),
    isActive: id => active && [...pairedDevices.values()].includes(id),
    ...(options.scopes ? { scopesOf: id => options.scopes!.get(id) } : {}) }, log, options.ttlMs, options.now);
  const registry = new CommandRegistry();
  const router = new CommandRouter(registry, auth, log, options.biometric);
  const addDevice = () => {
    const other = { deviceId: randomUUID(), credential: randomBytes(32).toString('base64url') };
    pairedDevices.set(other.credential, other.deviceId);
    return other;
  };
  return { deviceId, credential, log, auth, registry, router, addDevice, revoke: () => { active = false; } };
}

export async function testIdentity() {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-transport-test-'));
  const certificatePath = join(directory, 'certificate.pem');
  const privateKeyPath = join(directory, 'private-key.pem');
  try {
    const generated = await generate([{ name: 'commonName', value: 'localhost' }], { keyType: 'ec', algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }] });
    writeFileSync(certificatePath, generated.cert, { mode: 0o600 });
    writeFileSync(privateKeyPath, generated.private, { mode: 0o600 });
    return { directory, certificatePath, privateKeyPath,
      channel: loadEncryptedChannel(certificatePath, privateKeyPath),
      cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
