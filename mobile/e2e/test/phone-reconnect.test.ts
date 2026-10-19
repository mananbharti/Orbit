/** Stop/start resilience against the real desktop: stored credentials re-issue sessions, in-flight calls fail honestly. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { NotSent, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-reconn-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const addPhone = async () => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    return { paired, transport };
  };
  return { addPhone };
}

test('a stopped session starts again on the stored credential and keeps working', async t => {
  const { addPhone } = await world(t);
  const { paired, transport } = await addPhone();
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();
  const memory = new MemoryApi(session);
  await memory.remember({ name: 'before-restart', fact: 'one' });
  session.stop();
  assert.equal(session.status, 'stopped');
  await session.start();
  assert.equal(session.status, 'connected');
  assert.equal((await memory.recall('before-restart'))[0]?.facts[0], 'one'); // desktop state intact, fresh session issued
  session.stop();
});

test('a command in flight when the session stops fails honestly, never hangs', async t => {
  const { addPhone } = await world(t);
  const { paired, transport } = await addPhone();
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();
  const memory = new MemoryApi(session);
  const inFlight = memory.remember({ name: 'in-flight' });
  session.stop();
  await assert.rejects(inFlight, (e: unknown) => e instanceof NotSent || e instanceof Error);
  await session.start();
  await memory.remember({ name: 'after' });
  assert.equal((await memory.recall('after'))[0]?.name, 'after');
  session.stop();
});

test('rapid stop/start cycles settle connected, not wedged', async t => {
  const { addPhone } = await world(t);
  const { paired, transport } = await addPhone();
  const session = new OrbitSession(paired, transport, { uuid: randomUUID, retryBaseMs: 5, retryMaxMs: 20 });
  t.after(() => session.stop());
  for (let i = 0; i < 3; i++) { await session.start(); session.stop(); }
  await session.start();
  assert.equal(session.status, 'connected');
  await new MemoryApi(session).remember({ name: 'settled' });
  session.stop();
});
