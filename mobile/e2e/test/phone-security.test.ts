/** Negative and stress cases against the real desktop service: revocation, a second device, oversize and hostile input, many parallel calls. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { SystemApi } from '../../core/src/system.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-sec-'));
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
    return { paired, session, memory: new MemoryApi(session), system: new SystemApi(session), transport };
  };
  return { service, addPhone };
}

test('a revoked phone is cut off at once, cannot reconnect, and the other phone is unaffected', async t => {
  const { service, addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  await a.memory.remember({ name: 'before' });
  assert.equal(service.credentials.revoke(a.paired.deviceId), true);
  await assert.rejects(a.memory.recall('before'));
  const again = new OrbitSession(a.paired, a.transport, { uuid: randomUUID });
  await assert.rejects(again.start()); again.stop();
  assert.equal((await b.memory.recall('before'))[0]?.name, 'before');
});
test('two phones working at once both succeed; overlapping calls on ONE phone are refused cleanly, not corrupted', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  const run = async (phone: typeof a, tag: string) => { for (let i = 0; i < 15; i++) await phone.memory.remember({ name: `${tag}${i}`, fact: `fact ${i}` }); };
  await Promise.all([run(a, 'Alpha'), run(b, 'Beta')]);
  assert.equal((await a.memory.recall('Beta14'))[0]?.name, 'Beta14');
  assert.equal((await b.memory.recall('Alpha14'))[0]?.name, 'Alpha14');
  const overlap = await Promise.allSettled([a.memory.remember({ name: 'One' }), a.memory.remember({ name: 'Two' })]);
  assert.ok(overlap.filter(r => r.status === 'fulfilled').length >= 1, 'at least one overlapping call goes through');
  assert.equal((await a.memory.recall('Alpha0')).length > 0, true, 'session still usable afterwards');
});
test('oversize, wrong-type and injection-shaped input are rejected without hurting the session', async t => {
  const { addPhone } = await world(t);
  const p = await addPhone();
  await assert.rejects(p.memory.remember({ name: 'x'.repeat(5000) }));
  await assert.rejects(p.memory.remember({ name: 'ok', kind: '../../etc/passwd' }));
  await assert.rejects(p.session.command('memory.recall', { query: 123 as never }));
  await assert.rejects(p.session.command('memory.recall', { query: 'a', __proto__: { admin: true }, extra: 1 } as never));
  await assert.rejects(p.session.command('nonexistent.command', {}));
  await assert.rejects(p.session.command('session.refresh', {}));
  await p.memory.remember({ name: 'still works' });
  assert.equal((await p.memory.recall('still works'))[0]?.name, 'still works');
});

test('panic lock unpairs the calling phone and leaves other phones alone', async t => {
  const { addPhone } = await world(t);
  const a = await addPhone(); const b = await addPhone();
  await a.memory.remember({ name: 'panic-check' });
  const status = await a.system.panic();
  assert.ok(status === 'locked' || status === 'unpaired', `honest status, got ${status}`);
  await new Promise(resolve => setTimeout(resolve, 300)); // the unpair lands a tick after the panic reply, by design
  await assert.rejects(a.memory.recall('panic-check'), 'the panicking phone is cut off');
  assert.equal((await b.memory.recall('panic-check'))[0]?.name, 'panic-check', 'the other phone still works');
});
