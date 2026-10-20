/** The desktop's HTTPS entry points refuse browser-driven requests, guessing floods and malformed calls, with real sockets. */
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';

async function desktop(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-http-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const port = Number(new URL(service.hint.endpoint).port);
  const call = (path: string, headers: Record<string, string> = {}, method = 'POST') => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: service.hint.certificate, servername: 'localhost', checkServerIdentity: () => undefined }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
  return { service, call };
}

test('a request carrying an Origin header (a web page driving the LAN) is refused', async t => {
  const { call } = await desktop(t);
  const res = await call('/v1/pair', { Authorization: 'Bearer x', Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('unknown paths and wrong methods are 404, and a bad pairing token is a plain 401', async t => {
  const { call } = await desktop(t);
  assert.equal((await call('/v1/admin')).status, 404);
  assert.equal((await call('/v1/pair', {}, 'GET')).status, 404);
  const bad = await call('/v1/pair', { Authorization: 'Bearer not-a-real-token' });
  assert.equal(bad.status, 401);
  assert.ok(!bad.body.includes('not-a-real-token'), 'the reply never echoes the credential');
});

test('a guessing flood is cut off after the per-minute budget, even for a correct token', async t => {
  const { service, call } = await desktop(t);
  let refused = 0;
  for (let i = 0; i < 70; i++) { if ((await call('/v1/pair', { Authorization: `Bearer guess-${i}` })).status === 403) refused += 1; }
  assert.ok(refused >= 5, `later attempts were refused, got ${refused}`);
  const qr = service.pairing.open();
  assert.equal((await call('/v1/pair', { Authorization: `Bearer ${qr.pairingToken}` })).status, 403, 'the budget applies to everything from that address');
});
