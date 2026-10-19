/** Device management over the wire against the real desktop service: listing, scoping, revocation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { DevicesApi } from '../../core/src/devices.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-dev-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const sessions: OrbitSession[] = [];
  t.after(async () => { for (const s of sessions) s.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const addPhone = async () => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    const session = new OrbitSession(paired, transport, { uuid: randomUUID }); sessions.push(session);
    await session.start();
    return { paired, session, devices: new DevicesApi(session), memory: new MemoryApi(session) };
  };
  return { addPhone };
}

test('each phone sees the full device list with itself as current', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  const listA = await a.devices.refresh();
  assert.equal(a.devices.currentId(), a.paired.deviceId);
  assert.deepEqual(listA.map(d => d.deviceId).sort(), [a.paired.deviceId, b.paired.deviceId].sort());
  await b.devices.refresh();
  assert.equal(b.devices.currentId(), b.paired.deviceId);
});

test('scoping a phone down blocks the removed scope, restoring all brings it back', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  await b.memory.remember({ name: 'kept' });
  const narrowed = await a.devices.setScopes(b.paired.deviceId, ['memory']);
  assert.equal(narrowed.length, 2);
  await assert.rejects(b.session.command('file.offers', {}), (e: CommandError) => e instanceof CommandError && e.code === 'SCOPE_DENIED');
  assert.equal((await b.memory.recall('kept'))[0]?.name, 'kept'); // the kept scope still works
  const restored = await a.devices.setScopes(b.paired.deviceId, 'all');
  assert.equal(restored.length, 2);
  await b.session.command('file.offers', {});
});

test('revoking the other phone over the wire cuts it off and drops it from the list', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  const remaining = await a.devices.revoke(b.paired.deviceId);
  assert.deepEqual(remaining.map(d => d.deviceId), [a.paired.deviceId]);
  await assert.rejects(b.memory.remember({ name: 'late' }));
  const again = await a.devices.refresh();
  assert.deepEqual(again.map(d => d.deviceId), [a.paired.deviceId]);
});

test('a phone can revoke itself; the reply still lands before the cutoff', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  const remaining = await b.devices.revoke(b.paired.deviceId);
  assert.deepEqual(remaining.map(d => d.deviceId), [a.paired.deviceId]);
  await new Promise(r => setTimeout(r, 100)); // the self-revoke cutoff is deferred so this reply can land
  await assert.rejects(b.memory.remember({ name: 'late' }));
  await a.memory.remember({ name: 'fine' }); // the other phone is unaffected
});
