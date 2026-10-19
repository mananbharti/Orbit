/** Wire limits against the real desktop: oversize is refused before sending, and long pipelines stay healthy. */
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
  const root = mkdtempSync(join(tmpdir(), 'orbit-limits-'));
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
    return { session, memory: new MemoryApi(session) };
  };
  return { addPhone };
}

test('an oversize command is refused before it is sent, and the session keeps working', async t => {
  const { session, memory } = await world(t).then(w => w.addPhone());
  await assert.rejects(session.command('memory.remember', { name: 'x'.repeat(200_000) }),
    (e: unknown) => e instanceof NotSent, 'too large for the 64 KB wire cap');
  await memory.remember({ name: 'still-alive' });
  assert.equal((await memory.recall('still-alive'))[0]?.name, 'still-alive');
  assert.equal((await memory.recall('x'.repeat(100))).length, 0, 'the oversize command never reached the desktop');
});

test('200 sequential commands all resolve correctly - no leaks, no wedged pipeline', async t => {
  const { memory } = await world(t).then(w => w.addPhone());
  for (let i = 0; i < 200; i++) await memory.remember({ name: `seq${i}`, fact: `f${i}` });
  assert.equal((await memory.recall('seq0'))[0]?.facts[0], 'f0');
  assert.equal((await memory.recall('seq199'))[0]?.facts[0], 'f199');
});
