/** The persistent channel's upgrade entry point shares the per-address guessing budget with the HTTP entry points. */
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';

async function desktop(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-upgrade-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const port = Number(new URL(service.hint.endpoint).port);
  const base = { host: '127.0.0.1', port, ca: service.hint.certificate, servername: 'localhost', checkServerIdentity: () => undefined };
  const call = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ ...base, path, method: 'POST', headers }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject); req.end();
  });
  const upgrade = (token: string) => new Promise<number>((resolve, reject) => {
    const req = request({ ...base, path: '/v1/channel', method: 'GET', headers: {
      Authorization: `Bearer ${token}`, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('upgrade', res => { res.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
  return { service, call, upgrade };
}

test('channel upgrade guesses burn the same budget, then even a valid session token is refused', async t => {
  const { service, call, upgrade } = await desktop(t);
  const qr = service.pairing.open();
  const paired = JSON.parse((await call('/v1/pair', { Authorization: `Bearer ${qr.pairingToken}` })).body) as { credential: string };
  const session = JSON.parse((await call('/v1/session', { Authorization: `Bearer ${paired.credential}` })).body) as { sessionToken: string };
  assert.ok(session.sessionToken, 'a valid credential opens a session');
  for (let i = 0; i < 25; i++) assert.equal(await upgrade('x'.repeat(43)), 401, `guess ${i}`);
  assert.equal((await call('/v1/session', { Authorization: `Bearer ${paired.credential}` })).status, 403,
    'failed upgrades count against the address on the HTTP entry points too');
  assert.equal(await upgrade(session.sessionToken), 401, 'a cut-off address cannot open the channel even with a valid token');
});
