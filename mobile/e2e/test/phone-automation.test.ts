/** Phone core manages desktop automations over real TLS: create, replace, enable/disable, delete, persistence across restarts, scope refusal. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { AutomationApi } from '../../core/src/automation.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phoneOn(t: TestContext, service: Awaited<ReturnType<typeof startDesktop>>, scopes?: string[]) {
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open(scopes as never);
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(() => session.stop());
  await session.start();
  return new AutomationApi(session);
}

test('a phone manages the full automation lifecycle and it survives a restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-auto-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  const api = await phoneOn(t, service);

  const created = await api.save({ time: '07:30', days: [1, 2, 3], action: { type: 'power', action: 'lock' } });
  assert.equal(created.length, 1);
  const entry = created[0]!;
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.days, [1, 2, 3]);

  const replaced = await api.save({ id: entry.id, time: '08:00', days: [], action: { type: 'app', appId: 'spotify' } });
  assert.equal(replaced.length, 1, 'replace keeps one entry');
  assert.equal(replaced[0]!.time, '08:00');
  assert.deepEqual(replaced[0]!.days, [], 'empty days means every day');

  const disabled = await api.setEnabled(entry.id, false);
  assert.equal(disabled[0]!.enabled, false);
  assert.deepEqual((await api.refresh()).map(a => a.id), [entry.id]);

  await service.stop();
  const restarted = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => restarted.stop());
  const api2 = await phoneOn(t, restarted);
  const persisted = await api2.refresh();
  assert.equal(persisted.length, 1, 'the schedule survives a desktop restart');
  assert.equal(persisted[0]!.enabled, false);

  assert.deepEqual(await api2.remove(entry.id), []);
});

test('a scope-limited phone cannot manage automations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-auto-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => service.stop());
  const api = await phoneOn(t, service, ['clipboard']);
  await assert.rejects(api.refresh(), (e: CommandError) => typeof e.code === 'string');
  await assert.rejects(api.save({ time: '07:30', days: [], action: { type: 'power', action: 'lock' } }), (e: CommandError) => typeof e.code === 'string');
});

test('the desktop rejects invalid schedules at the protocol boundary', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-auto-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false });
  t.after(async () => service.stop());
  const api = await phoneOn(t, service);
  await assert.rejects(api.save({ time: '25:00', days: [], action: { type: 'power', action: 'lock' } }), (e: CommandError) => e.code === 'INVALID_PAYLOAD');
  await assert.rejects(api.save({ time: '07:30', days: [7], action: { type: 'power', action: 'lock' } }), (e: CommandError) => e.code === 'INVALID_PAYLOAD');
  await assert.rejects(api.remove('not-a-uuid'), (e: CommandError) => e.code === 'INVALID_PAYLOAD');
});
