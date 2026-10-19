import assert from 'node:assert/strict';
import test from 'node:test';
import { pairWithQr, PairingError } from '../src/pairing.js';
import { FakeTransport } from './fakes.js';

/** Deterministic PRNG so a fuzz failure is exactly reproducible from the seed. */
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

const BASE_QR = JSON.stringify({
  version: 1,
  desktopServiceId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Desk',
  endpoint: 'wss://192.168.1.20:8443/v1/channel',
  certificateFingerprint: 'ab'.repeat(32),
  pairingToken: 'c'.repeat(43),
  expiresAt: Date.now() + 60_000,
  macAddresses: ['aa:bb:cc:dd:ee:ff'],
});

function mutate(input: string, random: () => number): string {
  switch (Math.floor(random() * 7)) {
    case 0: { const c = [...input]; const i = Math.floor(random() * c.length); c[i] = String.fromCharCode(32 + Math.floor(random() * 95)); return c.join(''); }
    case 1: return input.slice(0, Math.floor(random() * input.length));
    case 2: return input + String.fromCharCode(...Array.from({ length: 8 }, () => Math.floor(random() * 65536)));
    case 3: { const p = JSON.parse(input) as Record<string, unknown>; delete p[['desktopServiceId', 'endpoint', 'pairingToken', 'expiresAt'][Math.floor(random() * 4)]!]; return JSON.stringify(p); }
    case 4: { const p = JSON.parse(input) as Record<string, unknown>; p[['endpoint', 'certificateFingerprint', 'pairingToken'][Math.floor(random() * 3)]!] = Math.floor(random() * 1e9); return JSON.stringify(p); }
    case 5: { const p = JSON.parse(input) as Record<string, unknown>; p.endpoint = ['wss://8.8.8.8:8443/v1/channel', 'https://192.168.1.20:8443/v1/channel', 'wss://192.168.1.20:8443/other', 'wss://user@192.168.1.20:8443/v1/channel'][Math.floor(random() * 4)]; return JSON.stringify(p); }
    default: { const p = JSON.parse(input) as Record<string, unknown>; p.expiresAt = [0, -1, 'soon', Date.now() - 1][Math.floor(random() * 4)]; return JSON.stringify(p); }
  }
}

test('500 mutated QR codes only ever fail as PairingError or pair cleanly - never a crash', async () => {
  const random = mulberry32(20261019);
  let invalid = 0; let expired = 0; let ok = 0;
  for (let i = 0; i < 500; i++) {
    const junk = mutate(BASE_QR, random);
    try {
      await pairWithQr(junk, new FakeTransport());
      ok++;
    } catch (error) {
      assert.ok(error instanceof PairingError, `mutation ${i} threw ${String(error)} for ${junk.slice(0, 120)}`);
      if (error.reason === 'invalid-qr') invalid++;
      else if (error.reason === 'expired') expired++;
    }
  }
  assert.ok(invalid > 100, `expected plenty of invalid rejections, got ${invalid}`);
  assert.ok(expired >= 1, 'expected at least one expired rejection');
  assert.ok(ok >= 0);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test('hostile endpoints are always rejected before any network use', async () => {
  for (const endpoint of ['wss://8.8.8.8:8443/v1/channel', 'https://192.168.1.20:8443/v1/channel',
    'wss://192.168.1.20:8443/', 'wss://user:pw@192.168.1.20:8443/v1/channel', 'wss://192.168.1.20:8443/v1/channel?x=1',
    'ws://192.168.1.20:8443/v1/channel', 'wss://example.com/v1/channel']) {
    const qr = JSON.stringify({ ...JSON.parse(BASE_QR), endpoint });
    const transport = new FakeTransport();
    await assert.rejects(pairWithQr(qr, transport), (e: PairingError) => e instanceof PairingError && e.reason === 'invalid-qr');
    assert.equal(transport.posts.length, 0, `endpoint ${endpoint} reached the network`);
  }
});
