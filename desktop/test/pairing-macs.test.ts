/** Verifies the pairing payload carries the desktop's NIC addresses for Wake-on-LAN; depends on a temp credential store. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pairingPayloadSchema } from '../src/protocol/pairing.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { PairingService } from '../src/security-pairing/pairing-service.js';
import { core } from './helpers.js';

function service(t: TestContext, macAddresses?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-pairing-macs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = core();
  const store = new FilePairedCredentialStore(join(root, 'credentials.json'));
  return new PairingService({ desktopServiceId: crypto.randomUUID(), displayName: 'Test PC',
    endpoint: 'wss://192.168.1.10:41855/v1/channel', certificateFingerprint: 'a'.repeat(64), ...(macAddresses ? { macAddresses } : {}) },
    store, setup.log);
}

test('a desktop with real NICs offers its MAC addresses in the pairing payload', t => {
  const macs = ['a1:b2:c3:d4:e5:f6', 'aa:bb:cc:dd:ee:ff'];
  const qr = service(t, macs).open();
  assert.equal(pairingPayloadSchema.safeParse(qr).success, true);
  assert.deepEqual(qr.macAddresses, macs);
});
test('a desktop without NIC info pairs exactly as before', t => {
  const qr = service(t).open();
  assert.equal(pairingPayloadSchema.safeParse(qr).success, true);
  assert.equal(qr.macAddresses, undefined);
});
