/** The real locator against real desktops: relocate after a restart; never trust a lookalike with a different identity. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { createLocator } from '../../core/src/locator.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const portOf = (endpoint: string): number => Number(new URL(endpoint).port);

test('after the desktop restarts on a new port, the locator finds it and the session works', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-locate-'));
  t.after(async () => rmSync(root, { recursive: true, force: true }));
  const start = () => startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const service1 = await start();
  const transport = new NodePinnedTransport(new Map());
  const qr = service1.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service1.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  await service1.stop(); // desktop down; phone only has the stale endpoint

  const service2 = await start();
  t.after(async () => { await service2.stop(); });
  const endpoints: string[] = [];
  const locator = createLocator({ transport, probeTimeoutMs: 500,
    discover: async () => [{ host: '127.0.0.1', port: portOf(service2.pairing.open().endpoint) }] }); // Bonjour finding the new port
  const session = new OrbitSession(paired, transport, { uuid: randomUUID, locator, onEndpointChanged: e => endpoints.push(e), searchCooldownMs: 0 });
  t.after(() => session.stop());
  await session.start();
  assert.equal(session.status, 'connected');
  assert.equal(endpoints.length, 1, 'the app is told the endpoint changed so it can persist it');
  await new MemoryApi(session).remember({ name: 'relocated' });
  session.stop();
});

test('a lookalike desktop on the same network is never trusted', async t => {
  const rootA = mkdtempSync(join(tmpdir(), 'orbit-real-'));
  const rootB = mkdtempSync(join(tmpdir(), 'orbit-fake-'));
  t.after(async () => { rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
  const real = await startDesktop({ directory: join(rootA, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = real.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, real.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  await real.stop(); // the real desktop vanishes

  const impostor = await startDesktop({ directory: join(rootB, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await impostor.stop(); });
  const locator = createLocator({ transport, probeTimeoutMs: 500,
    discover: async () => [{ host: '127.0.0.1', port: portOf(impostor.pairing.open().endpoint) }] }); // "found" - but a different identity
  const session = new OrbitSession(paired, transport, { uuid: randomUUID, locator, searchCooldownMs: 0, retryBaseMs: 5, retryMaxMs: 10 });
  t.after(() => session.stop());
  await session.start(); // transport failure keeps it searching in the background...
  assert.notEqual(session.status, 'connected');
  await new Promise(r => setTimeout(r, 120)); // ...across many retry cycles...
  assert.notEqual(session.status, 'connected'); // ...it never connects to the impostor
  await assert.rejects(new MemoryApi(session).remember({ name: 'never' }), /not sent/i); // and sends it nothing
  session.stop();
});
