/** Command pipeline under overlap: queued, serialized, every result matched to its own call; overflow refused honestly. */
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
import { NotSent, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-conc-'));
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
    return { session, memory: new MemoryApi(session), devices: new DevicesApi(session) };
  };
  return { addPhone };
}

test('a burst of overlapping mixed commands all resolve, each with its own result', async t => {
  const { addPhone } = await world(t);
  const p = await addPhone();
  const calls: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    calls.push(p.memory.remember({ name: `burst${i}`, fact: `fact ${i}` }));
    calls.push(p.devices.refresh());
  }
  const results = await Promise.all(calls); // every single one, not just "at least one"
  assert.equal(results.length, 8);
  for (let i = 0; i < 4; i++) assert.equal((await p.memory.recall(`burst${i}`))[0]?.facts[0], `fact ${i}`);
});

test('queue overflow is refused honestly and the session keeps working', async t => {
  const { addPhone } = await world(t);
  const p = await addPhone();
  // 30 slow overlapping commands: one in flight, up to 16 queued, the rest must fail as NotSent - never hang, never corrupt.
  const calls = Array.from({ length: 30 }, (_, i) => p.session.command('memory.remember', { name: `over${i}` }));
  const settled = await Promise.allSettled(calls);
  const fulfilled = settled.filter(r => r.status === 'fulfilled').length;
  const refused = settled.filter(r => r.status === 'rejected' && r.reason instanceof NotSent);
  assert.equal(fulfilled + refused.length, 30);
  assert.ok(fulfilled >= 1 && fulfilled <= 17, `in flight + queue capacity, got ${fulfilled}`);
  assert.ok(refused.length >= 13, `overflow refused, got ${refused.length}`);
  await p.memory.remember({ name: 'afterwards' });
  assert.equal((await p.memory.recall('afterwards'))[0]?.name, 'afterwards');
});

test('two phones overlapping at once never cross results', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  const [ra, rb] = await Promise.all([
    Promise.all(Array.from({ length: 8 }, (_, i) => a.memory.remember({ name: `A${i}`, fact: 'alpha' }))),
    Promise.all(Array.from({ length: 8 }, (_, i) => b.memory.remember({ name: `B${i}`, fact: 'beta' }))),
  ]);
  assert.equal(ra.length + rb.length, 16);
  assert.equal((await a.memory.recall('B7'))[0]?.facts[0], 'beta');
  assert.equal((await b.memory.recall('A7'))[0]?.facts[0], 'alpha');
});
