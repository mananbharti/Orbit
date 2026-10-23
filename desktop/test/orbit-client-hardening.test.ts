/** Pins OrbitClient session validation against a misbehaving session issuer; depends on a real paired fixture and the impostor TLS pattern. */
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
import { OrbitClient } from '../src/integration-client/orbit-client.js';

async function fixture(t: TestContext, sessionResponse: (deviceId: string) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-oc-hard-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0,
    displayName: 'Orbit Test', discovery: false, sessionTtlMs: 60_000, registry: new CommandRegistry() });
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const identity = JSON.parse(readFileSync(join(service.directory, 'identity.json'), 'utf8'));
  const impostor = createServer({ key: identity.privateKey, cert: identity.certificate }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessionResponse(paired.deviceId)));
  });
  await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', resolve));
  t.after(async () => { impostor.close(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const port = (impostor.address() as { port: number }).port;
  return { paired: { ...paired, endpoint: `wss://127.0.0.1:${port}/v1/channel` } };
}

const session = (deviceId: string, expiresAt: number) =>
  ({ version: 1, deviceId, sessionId: randomUUID(), expiresAt, sessionToken: 'x'.repeat(43) });

test('a session issued for a different device is rejected as authentication failure', async t => {
  const { paired } = await fixture(t, () => session(randomUUID(), Date.now() + 60_000));
  const client = new OrbitClient(paired);
  await assert.rejects(client.start(), /re-pairing may be required/);
});

test('an already-expired session is rejected instead of opening a channel', async t => {
  const { paired } = await fixture(t, deviceId => session(deviceId, Date.now() - 1));
  const client = new OrbitClient(paired);
  await assert.rejects(client.start(), /re-pairing may be required/);
});

async function connectedFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-oc-conn-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0,
    displayName: 'Orbit Test', discovery: false, sessionTtlMs: 60_000, registry: new CommandRegistry() });
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired);
  await client.start();
  t.after(async () => { client.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  return { client };
}

test('reserved session.* commands, overlong types and oversized payloads are refused locally', async t => {
  const { client } = await connectedFixture(t);
  await assert.rejects(client.command('session.renew' as never, {}), /Invalid feature command/);
  await assert.rejects(client.command('x'.repeat(65) as never, {}), /Invalid feature command/);
  await assert.rejects(client.command(('a'.repeat(34) + '.' + 'b'.repeat(34)) as never, {}), /Invalid feature command/); // pattern-valid but over 64 chars
  await assert.rejects(client.command('clipboard.write' as never, { text: 'y'.repeat(70_000) } as never), /exceeds message limit/);
});

test('only one command is in flight at a time, and the online queue is bounded', async t => {
  const { client } = await connectedFixture(t);
  const first = client.command('clipboard.history' as never, {});
  await assert.rejects(client.command('clipboard.history' as never, {}), /already pending/);
  await first.catch(() => {});
  const attempts: Promise<unknown>[] = [];
  for (let i = 0; i < 18; i++) attempts.push(client.scheduledCommand('clipboard.history' as never, {}).catch(e => e));
  const results = await Promise.all(attempts);
  assert.ok(results.some(r => r instanceof Error && /No live command slot/.test((r as Error).message)),
    'with one in flight and 16 queued, the 18th concurrent command must be refused a slot');
});

test('a stored paired credential with a malformed fingerprint is rejected on load', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-pd-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { savePairedDesktop, loadPairedDesktop } = await import('../src/integration-client/paired-desktop.js');
  const valid = { desktopServiceId: randomUUID(), deviceId: randomUUID(), endpoint: 'wss://127.0.0.1:4700/v1/channel',
    certificate: 'x'.repeat(64), certificateFingerprint: 'ab'.repeat(32), credential: 'x'.repeat(43) };
  savePairedDesktop(root, valid);
  assert.equal(loadPairedDesktop(root).deviceId, valid.deviceId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'paired-desktop.json'), JSON.stringify({ ...valid, certificateFingerprint: 'Z'.repeat(64) }));
  assert.throws(() => loadPairedDesktop(root));
  writeFileSync(join(root, 'paired-desktop.json'), JSON.stringify({ ...valid, certificateFingerprint: 'ab'.repeat(31) }));
  assert.throws(() => loadPairedDesktop(root));
});
