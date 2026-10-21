/** Discovery advertisement encode/decode and the settle guarantees: a wedged Bonjour must never hang stop() or discovery. */
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from 'selfsigned';
import type Bonjour from 'bonjour-service';
import { advertiseDesktop, decodeAdvertisement, discoverDesktop, encodeAdvertisement, type DesktopHint } from '../src/transport/discovery/lan-discovery.js';

// A real throwaway self-signed certificate, the same way the desktop identity makes one.
const CERT = new X509Certificate((await generate([{ name: 'commonName', value: 'Orbit Test' }],
  { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })).cert).toString();

const hint: DesktopHint = { desktopServiceId: '00000000-0000-4000-8000-000000000001',
  displayName: 'OMEN', endpoint: 'wss://192.168.137.1:9123/v1/channel', certificate: CERT };

test('an advertisement round-trips through chunked TXT records', () => {
  const txt = encodeAdvertisement(hint);
  assert.equal(txt.version, '1');
  assert.equal(Number(txt.parts) >= 1, true);
  for (const [key, value] of Object.entries(txt)) if (key.startsWith('cert')) assert.ok(value.length <= 200);
  const decoded = decodeAdvertisement(txt);
  assert.deepEqual(decoded, hint);
});

test('decodeAdvertisement refuses malformed, oversized and tampered records', () => {
  const good = encodeAdvertisement(hint);
  assert.equal(decodeAdvertisement(undefined), undefined);
  assert.equal(decodeAdvertisement({ version: '2' }), undefined);
  assert.equal(decodeAdvertisement({ ...good, version: '2' }), undefined, 'wrong version');
  assert.equal(decodeAdvertisement({ ...good, extra: 'x' }), undefined, 'unexpected key');
  assert.equal(decodeAdvertisement({ ...good, parts: '9' }), undefined, 'wrong part count');
  // Break the DER structure itself. Content tampering that stays parseable is caught later by the fingerprint comparison.
  assert.equal(decodeAdvertisement({ ...good, cert0: `XX${good.cert0!.slice(2)}` }), undefined, 'structurally broken certificate');
  assert.equal(decodeAdvertisement({ ...good, endpoint: 'https://evil.example.com/v1/channel' }), undefined, 'non-local endpoint');
  assert.equal(decodeAdvertisement({ ...good, cert0: `${'A'.repeat(201)}` }), undefined, 'oversized chunk');
});

interface FakeBrowser { stop(): void }
// A faithful wedge: like a real stuck multicast socket, the fake holds the event loop open forever
// (the caller must clear the handle); it just never answers destroy's callback.
function wedgedBonjour() {
  const calls = { published: false, found: false, destroyed: 0 };
  const wedge = setInterval(() => {}, 60_000);
  const fake = {
    publish: () => { calls.published = true; return { on: () => {}, stop: (cb: () => void) => cb() }; },
    find: () => { calls.found = true; const browser: FakeBrowser = { stop: () => {} }; return browser; },
    destroy: (_cb: () => void) => { calls.destroyed++; /* never calls back: the wedged-socket case */ },
  } as unknown as Bonjour;
  return { fake, calls, release: () => clearInterval(wedge) };
}

test('stop() settles even when Bonjour never finishes destroying', async t => {
  const { fake, calls, release } = wedgedBonjour();
  t.after(release);
  const service = advertiseDesktop(hint, () => {}, () => fake);
  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 5_000, 'stop must settle promptly despite the wedged destroy');
  assert.equal(calls.destroyed, 1, 'destroy is attempted exactly once');
});

test('discoverDesktop settles as a timeout even when Bonjour never finishes destroying', async t => {
  const { fake, calls, release } = wedgedBonjour();
  t.after(release);
  const started = Date.now();
  await assert.rejects(
    discoverDesktop({ desktopServiceId: hint.desktopServiceId, certificateFingerprint: 'ab'.repeat(32) }, 100, undefined, () => fake),
    /unavailable or timed out/);
  assert.ok(Date.now() - started < 5_000, 'discovery must settle despite the wedged destroy');
  assert.equal(calls.destroyed, 1);
});

test('discoverDesktop aborts promptly on the caller signal even when Bonjour never finishes destroying', async t => {
  const { fake, release } = wedgedBonjour();
  t.after(release);
  const abort = new AbortController();
  const started = Date.now();
  const pending = discoverDesktop({ desktopServiceId: hint.desktopServiceId, certificateFingerprint: 'ab'.repeat(32) }, 60_000, abort.signal, () => fake);
  abort.abort();
  await assert.rejects(pending, /unavailable or timed out/);
  assert.ok(Date.now() - started < 5_000, 'an aborted discovery must settle despite the wedged destroy');
});
