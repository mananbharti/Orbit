/** Pairing security over the real stack: one QR enrolls exactly one phone; bad or stale codes enroll nothing. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { DevicesApi } from '../../core/src/devices.js';
import { pairWithQr, PairingError } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-pair-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = (fingerprint: string) => {
    const tr = new NodePinnedTransport(new Map());
    (tr as unknown as { certificates: Map<string, string> }).certificates.set(fingerprint, service.hint.certificate);
    return tr;
  };
  return { service, transport };
}

test('a pairing QR works exactly once; a second redemption is rejected and enrolls nothing', async t => {
  const { service, transport } = await world(t);
  const qrText = JSON.stringify(service.pairing.open());
  const paired = await pairWithQr(qrText, transport(JSON.parse(qrText).certificateFingerprint));
  await assert.rejects(pairWithQr(qrText, transport(JSON.parse(qrText).certificateFingerprint)),
    (e: unknown) => e instanceof PairingError && e.reason === 'rejected' && /used already|new one/i.test(e.message));
  // The one enrolled phone sees exactly itself in the device list: the rejected redemption added nothing.
  const session = new OrbitSession(paired, transport(paired.certificateFingerprint), { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();
  assert.deepEqual((await new DevicesApi(session).refresh()).map(d => d.deviceId), [paired.deviceId]);
});

test('a tampered token is rejected without burning the real QR, and an expired code never leaves the phone', async t => {
  const { service, transport } = await world(t);
  const qr = service.pairing.open();
  const tampered = JSON.stringify({ ...qr, pairingToken: randomBytes(32).toString('base64url') });
  await assert.rejects(pairWithQr(tampered, transport(qr.certificateFingerprint)),
    (e: unknown) => e instanceof PairingError && e.reason === 'rejected');
  // A guessed/wrong token must not consume the invitation: the real QR still pairs afterwards.
  const paired = await pairWithQr(JSON.stringify(qr), transport(qr.certificateFingerprint));
  assert.ok(paired.deviceId);
  // Expiry is checked on the phone before any network call: a stale code is refused even with the desktop up.
  const qr2 = service.pairing.open();
  await assert.rejects(pairWithQr(JSON.stringify(qr2), transport(qr2.certificateFingerprint), () => qr2.expiresAt + 1),
    (e: unknown) => e instanceof PairingError && e.reason === 'expired' && /expired/i.test(e.message));
  // And the real second QR still works when scanned in time.
  const paired2 = await pairWithQr(JSON.stringify(qr2), transport(qr2.certificateFingerprint));
  assert.ok(paired2.deviceId);
  const session = new OrbitSession(paired2, transport(paired2.certificateFingerprint), { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();
  assert.equal((await new DevicesApi(session).refresh()).length, 2); // exactly the two real pairings, no phantoms
});
