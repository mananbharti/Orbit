import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { startDesktop } from '../src/desktop-service.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-pd-hard-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0,
    displayName: 'Orbit Test', discovery: false, sessionTtlMs: 60_000, registry: new CommandRegistry() });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  return { service };
}

test('an expired QR fails locally before any enrollment attempt', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  await assert.rejects(pairDesktop({ ...qr, expiresAt: Date.now() - 1 }, service.hint), /expired or discovery did not match/);
  assert.ok(await pairDesktop(qr, service.hint), 'the still-valid invitation remains redeemable');
});

test('a discovery hint for a different desktop service id fails before enrollment', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  await assert.rejects(pairDesktop(qr, { ...service.hint, desktopServiceId: randomUUID() }), /expired or discovery did not match/);
  assert.ok(await pairDesktop(qr, service.hint), 'the still-valid invitation remains redeemable');
});

test('a pairing response naming a different desktop service id is rejected', async t => {
  const { service } = await fixture(t);
  // A holder of the real identity key that answers /v1/pair with somebody else's service id.
  const identity = JSON.parse(readFileSync(join(service.directory, 'identity.json'), 'utf8'));
  const impostor = createServer({ key: identity.privateKey, cert: identity.certificate }, ( _req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, desktopServiceId: randomUUID(), deviceId: randomUUID(), credential: 'x'.repeat(43) }));
  });
  await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(() => impostor.close());
  const port = (impostor.address() as { port: number }).port;
  const endpoint = `wss://127.0.0.1:${port}/v1/channel`;
  const qr = { ...service.pairing.open(), endpoint };
  await assert.rejects(pairDesktop(qr, { ...service.hint, endpoint }), /Invalid pairing response/);
});

async function impostorServer(t: TestContext, directory: string, respond: (res: import('node:http').ServerResponse) => void) {
  const identity = JSON.parse(readFileSync(join(directory, 'identity.json'), 'utf8'));
  const server = createServer({ key: identity.privateKey, cert: identity.certificate }, (_req, res) => respond(res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `wss://127.0.0.1:${(server.address() as { port: number }).port}/v1/channel`;
}

test('a desktop response over the 16 KB limit is rejected', async t => {
  const { service } = await fixture(t);
  const endpoint = await impostorServer(t, service.directory, res => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"pad":"' + 'x'.repeat(20_000) + '"}');
  });
  await assert.rejects(pairDesktop({ ...service.pairing.open(), endpoint }, { ...service.hint, endpoint }), /exceeded limit/);
});

test('a 401 from the desktop means authentication was rejected, not a generic failure', async t => {
  const { service } = await fixture(t);
  const endpoint = await impostorServer(t, service.directory, res => { res.writeHead(401); res.end(); });
  await assert.rejects(pairDesktop({ ...service.pairing.open(), endpoint }, { ...service.hint, endpoint }), /re-pairing may be required/);
});

test('a non-200 response with a valid-looking body is still rejected', async t => {
  const { service } = await fixture(t);
  const endpoint = await impostorServer(t, service.directory, res => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 1, desktopServiceId: service.hint.desktopServiceId, deviceId: randomUUID(), credential: 'x'.repeat(43) }));
  });
  await assert.rejects(pairDesktop({ ...service.pairing.open(), endpoint }, { ...service.hint, endpoint }), /request rejected/);
});
