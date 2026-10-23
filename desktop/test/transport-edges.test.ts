/** Verifies discovery chunk limits and TLS identity matching the main suites leave open; depends on throwaway self-signed certificates only. */
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generate } from 'selfsigned';
import { decodeAdvertisement, encodeAdvertisement, type DesktopHint } from '../src/transport/discovery/lan-discovery.js';
import { loadEncryptedChannel } from '../src/transport/websocket/encrypted-channel.js';

const CERT = new X509Certificate((await generate([{ name: 'commonName', value: 'Orbit Test' }],
  { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' })).cert).toString();
const hint: DesktopHint = { desktopServiceId: '00000000-0000-4000-8000-000000000001',
  displayName: 'OMEN', endpoint: 'wss://192.168.137.1:9123/v1/channel', certificate: CERT };

function rechunks(size: number, count?: number): Record<string, string> {
  const txt = encodeAdvertisement(hint);
  const encoded = Array.from({ length: Number(txt.parts) }, (_, i) => txt[`cert${i}`]!).join('');
  const chunks = encoded.match(new RegExp(`.{1,${size}}`, 'g'))!;
  const fields: Record<string, string> = { version: '1', id: hint.desktopServiceId, name: hint.displayName,
    endpoint: hint.endpoint, parts: String(count ?? chunks.length) };
  chunks.forEach((chunk, i) => { fields[`cert${i}`] = chunk; });
  return fields;
}

test('an advertisement split into more than eight chunks is refused even when well-formed', () => {
  const fields = rechunks(56); // the same certificate, just more, smaller chunks
  assert.ok(Number(fields.parts) > 8, 'the fixture really exceeds the chunk limit');
  assert.equal(decodeAdvertisement(fields), undefined);
});

test('a chunk longer than 200 characters is refused even under the 256 field cap', () => {
  const fields = rechunks(240);
  assert.equal(decodeAdvertisement(fields), undefined);
});

test('a certificate and key from different identities are refused', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-tls-edges-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await generate([{ name: 'commonName', value: 'Orbit A' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' });
  const second = await generate([{ name: 'commonName', value: 'Orbit B' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256' });
  const certPath = join(dir, 'cert.pem'); const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, first.cert); writeFileSync(keyPath, second.private);
  assert.throws(() => loadEncryptedChannel(certPath, keyPath), /identity does not match/);
  writeFileSync(keyPath, first.private);
  const channel = loadEncryptedChannel(certPath, keyPath);
  assert.match(channel.certificateFingerprint, /^[a-f0-9]{64}$/);
});
