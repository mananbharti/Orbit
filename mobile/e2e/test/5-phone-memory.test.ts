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
