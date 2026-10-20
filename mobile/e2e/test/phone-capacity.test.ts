/** The desktop caps live phone connections; the cap is enforced cleanly and frees up as phones leave. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { MemoryApi } from '../../core/src/memory.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

test('the 33rd live phone is not admitted until one leaves, and the existing phones are unaffected', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-capacity-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const sessions: OrbitSession[] = [];
  t.after(async () => { for (const s of sessions) s.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const add = async (retryBaseMs: number) => {
    const transport = new NodePinnedTransport(new Map());
    const qr = service.pairing.open();
    (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
    const paired = await pairWithQr(JSON.stringify(qr), transport);
    const session = new OrbitSession(paired, transport, { uuid: randomUUID, retryBaseMs, retryMaxMs: 1_500 });
    sessions.push(session);
    return session;
  };
  for (let i = 0; i < 32; i++) { const s = await add(500); await s.start(); }
  assert.ok(sessions.every(s => s.status === 'connected'), 'all 32 are in');
  const extra = await add(300);
  await extra.start().catch(() => undefined);
  assert.notEqual(extra.status, 'connected', 'the 33rd is held out at the cap');
  await new MemoryApi(sessions[0]!).remember({ name: 'cap-check' });
  sessions[1]!.stop(); // one phone leaves
  const by = Date.now() + 15_000;
  while (extra.status !== 'connected' && Date.now() < by) await new Promise(r => setTimeout(r, 100));
  assert.equal(extra.status, 'connected', 'the waiting phone gets in once a slot is free');
  assert.equal((await new MemoryApi(extra).recall('cap-check'))[0]?.name, 'cap-check');
});
