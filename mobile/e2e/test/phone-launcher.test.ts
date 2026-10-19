/** Phone core lists and launches apps on the real desktop service with a synthetic activation adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { LauncherApi } from '../../core/src/launcher.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, NotSent, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-launch-'));
  let launches = 0; let revision = 'one';
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    launcher: { createAdapter: () => ({
      list: async () => [{ key: 'registration', name: 'Notes', revision }, { key: 'registration-2', name: 'Browser', revision }],
      launch: async (_app, authorize) => { authorize(); launches++; } }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api: new LauncherApi(session), launches: () => launches, change: () => { revision = 'two'; } };
}

test('phone lists the desktop apps and launches one', async t => {
  const f = await phone(t);
  const apps = await f.api.list();
  assert.deepEqual(apps.map(a => a.name).sort(), ['Browser', 'Notes']);
  await f.api.launch(apps[0]!.appId);
  assert.equal(f.launches(), 1);
});
test('a launch with an old catalog is refused and nothing opens', async t => {
  const f = await phone(t);
  const apps = await f.api.list();
  f.change();
  await assert.rejects(f.api.launch(apps[0]!.appId), (e: CommandError) => e.code === 'LAUNCHER_STALE_CATALOG');
  assert.equal(f.launches(), 0);
  await assert.rejects(f.api.launch(apps[0]!.appId), NotSent);
  const fresh = await f.api.list();
  await f.api.launch(fresh[0]!.appId);
  assert.equal(f.launches(), 1);
});

test('pins and scenes survive a desktop restart (same directory, same identity)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launch-persist-'));
  const adapter = () => ({
    list: async () => [{ key: 'registration', name: 'Notes', revision: 'one' }, { key: 'registration-2', name: 'Browser', revision: 'one' }],
    launch: async (_app: unknown, authorize: () => void) => { authorize(); } });
  const start = () => startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    launcher: { createAdapter: adapter } });
  const service1 = await start();
  const transport = new NodePinnedTransport(new Map());
  const qr = service1.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service1.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session1 = new OrbitSession(paired, transport, { uuid: randomUUID });
  await session1.start();
  const api1 = new LauncherApi(session1);
  const apps = await api1.list();
  const notes = apps.find(a => a.name === 'Notes')!;
  await api1.pin(notes.appId);
  await api1.saveScene('Work', apps.map(a => a.appId));
  session1.stop();
  await service1.stop();

  const service2 = await start();
  t.after(async () => { await service2.stop(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(service2.hint.certificate, service1.hint.certificate, 'desktop identity persists in the directory');
  const relocated = { ...paired, endpoint: service2.pairing.open().endpoint }; // what the locator does after the port changes
  const session2 = new OrbitSession(relocated, transport, { uuid: randomUUID });
  t.after(() => session2.stop());
  await session2.start(); // same stored credential, no re-pairing after a PC app restart
  const api2 = new LauncherApi(session2);
  await api2.list();
  assert.deepEqual(api2.getPinned(), [notes.appId]);
  const scenes = await api2.scenes();
  const work = scenes.find(s => s.name === 'Work')!;
  assert.deepEqual(work.appIds, apps.map(a => a.appId));
  session2.stop();
});
