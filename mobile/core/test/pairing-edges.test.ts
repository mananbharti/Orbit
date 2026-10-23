import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingError, pairWithQr } from '../src/pairing.js';
import { DESKTOP, DEVICE, ENDPOINT, FINGERPRINT, FakeTransport, token } from './fakes.js';

const qr = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, desktopServiceId: DESKTOP, displayName: 'Desk',
  endpoint: ENDPOINT, certificateFingerprint: FINGERPRINT, pairingToken: token('p'), expiresAt: 1_000, ...over });
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as PairingError).reason; } return 'none'; };

test('a code expiring right now is already dead, one expiring a tick later still pairs', async () => {
  assert.equal(await reason(pairWithQr(qr({ expiresAt: 1_000 }), new FakeTransport(), () => 1_000)), 'expired');
  assert.equal(await reason(pairWithQr(qr({ expiresAt: 999 }), new FakeTransport(), () => 1_000)), 'expired');
  assert.equal(await reason(pairWithQr(qr({ expiresAt: 1_001 }), new FakeTransport(), () => 1_000)), 'none');
});
test('wake-on-lan addresses from the code land in the stored record, and stay absent when not given', async () => {
  const macs = ['aa:bb:cc:dd:ee:ff', '11:22:33:44:55:66'];
  const withMacs = await pairWithQr(qr({ expiresAt: Date.now() + 60_000, macAddresses: macs }), new FakeTransport());
  assert.deepEqual(withMacs.macAddresses, macs);
  assert.equal('macAddresses' in await pairWithQr(qr({ expiresAt: Date.now() + 60_000 }), new FakeTransport()), false);
  const withEmpty = await pairWithQr(qr({ expiresAt: Date.now() + 60_000, macAddresses: [] }), new FakeTransport());
  assert.equal('macAddresses' in withEmpty, false);
  assert.equal(withEmpty.deviceId, DEVICE);
});
