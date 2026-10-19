/** Phone core remembers, recalls and forgets on the real desktop service. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext, scopes?: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-mem-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open(scopes as never);
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return new MemoryApi(session);
}

test('phone remembers, recalls with related entities, then forgets', async t => {
  const api = await phone(t);
  const id = await api.remember({ name: 'Rahul', kind: 'person', fact: 'prefers WhatsApp', relatedTo: 'Orbit', relation: 'works-on' });
  const hits = await api.recall('rahul');
  assert.equal(hits[0]!.name, 'Rahul'); assert.deepEqual(hits[0]!.facts, ['prefers WhatsApp']);
  assert.ok(hits.some(h => h.name === 'Orbit' && h.via === 'works-on Rahul'));
  assert.equal(await api.forget(id), true);
  assert.deepEqual(await api.recall('rahul'), []);
});
test('a phone without the memory scope is refused', async t => {
  const api = await phone(t, ['clipboard']);
  await assert.rejects(api.recall('x'), (e: CommandError) => typeof e.code === 'string');
});

test('remembering the same name again adds facts to one entity, and an alias finds it', async t => {
  const api = await phone(t);
  const first = await api.remember({ name: 'Priya', kind: 'person', fact: 'likes chai', alias: 'Pri' });
  const second = await api.remember({ name: 'Priya', fact: 'lives in Pune' });
  assert.equal(second, first, 'same entity, not a duplicate');
  const hits = await api.recall('priya');
  assert.equal(hits.filter(h => h.name === 'Priya').length, 1);
  assert.deepEqual([...hits[0]!.facts].sort(), ['likes chai', 'lives in Pune']);
  assert.equal((await api.recall('Pri'))[0]?.name, 'Priya', 'the alias recalls it');
});

test('forgetting an id that is gone reports false, and recall limit is honoured', async t => {
  const api = await phone(t);
  for (const name of ['Alpha one', 'Alpha two', 'Alpha three']) await api.remember({ name, fact: 'alpha' });
  assert.ok((await api.recall('alpha', 2)).length <= 2);
  const id = await api.remember({ name: 'Temp', fact: 'x' });
  assert.equal(await api.forget(id), true);
  assert.equal(await api.forget(id), false);
});

test('memory survives a desktop restart in the same directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-mem-persist-'));
  const start = () => startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const service1 = await start();
  const transport = new NodePinnedTransport(new Map());
  const qr = service1.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service1.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session1 = new OrbitSession(paired, transport, { uuid: randomUUID });
  await session1.start();
  await new MemoryApi(session1).remember({ name: 'Orbit launch', fact: 'ships on the 24th' });
  session1.stop();
  await service1.stop();

  const service2 = await start();
  t.after(async () => { await service2.stop(); rmSync(root, { recursive: true, force: true }); });
  const session2 = new OrbitSession({ ...paired, endpoint: service2.pairing.open().endpoint }, transport, { uuid: randomUUID });
  t.after(() => session2.stop());
  await session2.start();
  const hits = await new MemoryApi(session2).recall('orbit launch');
  assert.deepEqual(hits[0]?.facts, ['ships on the 24th']);
});
