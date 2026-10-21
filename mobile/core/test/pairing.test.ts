import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingError, pairWithQr, peekPairingDesktopId } from '../src/pairing.js';
import { AuthenticationRejected, TransportError, explainTransportFailure } from '../src/transport.js';
import { DESKTOP, DEVICE, ENDPOINT, FINGERPRINT, FakeTransport, token } from './fakes.js';

const qr = (over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, desktopServiceId: DESKTOP, displayName: 'Desk',
  endpoint: ENDPOINT, certificateFingerprint: FINGERPRINT, pairingToken: token('p'), expiresAt: Date.now() + 60_000, ...over });
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as PairingError).reason; } return 'none'; };

test('pairs with the QR token and the QR fingerprint, returns the credential to store', async () => {
  const t = new FakeTransport();
  const result = await pairWithQr(qr(), t);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0]!.path, '/v1/pair');
  assert.equal(t.posts[0]!.token, token('p'));
  assert.equal(t.posts[0]!.trust.certificateFingerprint, FINGERPRINT);
  assert.deepEqual(result, { desktopServiceId: DESKTOP, displayName: 'Desk', deviceId: DEVICE, endpoint: ENDPOINT,
    certificateFingerprint: FINGERPRINT, credential: token('c') });
});
test('rejects text that is not an Orbit QR without touching the network', async () => {
  const t = new FakeTransport();
  for (const bad of ['hello', '{}', qr({ extra: 1 }), qr({ version: 2 }), qr({ certificateFingerprint: 'AB' }), qr({ pairingToken: 'short' })]) {
    assert.equal(await reason(pairWithQr(bad, t)), 'invalid-qr');
  }
  assert.equal(t.posts.length, 0);
});
test('refuses endpoints that are not local wss channel addresses', async () => {
  const t = new FakeTransport();
  for (const endpoint of ['wss://example.com:8443/v1/channel', 'ws://192.168.1.20:8443/v1/channel', 'wss://8.8.8.8/v1/channel',
    'wss://192.168.1.20/v1/other', 'wss://u:p@192.168.1.20/v1/channel', 'wss://192.168.1.20/v1/channel?x=1', 'wss://172.32.0.1/v1/channel']) {
    assert.equal(await reason(pairWithQr(qr({ endpoint }), t)), 'invalid-qr', endpoint);
  }
  for (const endpoint of ['wss://10.0.0.5:1/v1/channel', 'wss://172.16.0.1/v1/channel', 'wss://[::1]:9/v1/channel', 'wss://169.254.1.1/v1/channel']) {
    assert.equal(await reason(pairWithQr(qr({ endpoint }), new FakeTransport())), 'none', endpoint);
  }
  assert.equal(t.posts.length, 0);
});
test('rejects an expired code locally', async () => {
  const t = new FakeTransport();
  assert.equal(await reason(pairWithQr(qr({ expiresAt: Date.now() - 1 }), t)), 'expired');
  assert.equal(t.posts.length, 0);
});
test('transport failure and bad identity are distinct, safe errors', async () => {
  const t = new FakeTransport();
  t.failPost = new Error('pin mismatch with secret detail');
  const error = (await pairWithQr(qr(), t).catch(e => e)) as PairingError;
  assert.equal(error.reason, 'rejected');
  assert.doesNotMatch(error.message, /secret/);
  const other = new FakeTransport();
  other.postResult = () => ({ version: 1, desktopServiceId: '33333333-3333-4333-8333-333333333333', deviceId: DEVICE, credential: token('c') });
  assert.equal(await reason(pairWithQr(qr(), other)), 'mismatch');
  const junk = new FakeTransport();
  junk.postResult = () => ({ nope: true });
  assert.equal(await reason(pairWithQr(qr(), junk)), 'mismatch');
});
test('each classified network failure gets its own plain explanation', async () => {
  const messages = new Set<string>();
  for (const kind of ['pin-mismatch', 'timeout', 'refused', 'unreachable', 'local-network-denied'] as const) {
    const t = new FakeTransport();
    t.failPost = new TransportError(kind);
    const error = (await pairWithQr(qr(), t).catch(e => e)) as PairingError;
    assert.equal(error.reason, 'rejected');
    assert.equal(error.message, explainTransportFailure(kind));
    messages.add(error.message);
  }
  assert.equal(messages.size, 5);
  const used = new FakeTransport();
  used.failPost = new AuthenticationRejected();
  assert.match(((await pairWithQr(qr(), used).catch(e => e)) as PairingError).message, /did not accept this code/);
});

test('peekPairingDesktopId reads the identity for a capacity check without touching the network', () => {
  assert.equal(peekPairingDesktopId(qr()), DESKTOP, 'a recognizable code names its desktop');
  assert.equal(peekPairingDesktopId(qr({ expiresAt: 1 })), DESKTOP, 'even an expired code: pairWithQr reports the expiry properly');
  for (const bad of ['hello', '', '{}', qr({ version: 2 }), qr({ desktopServiceId: 'not-a-uuid' }), 'null']) {
    assert.equal(peekPairingDesktopId(bad), undefined, `not recognizable: ${bad.slice(0, 24)}`);
  }
});
