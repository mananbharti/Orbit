/** Launcher favourites and scenes over the wire: ordering, validation, partial launch failure, delete. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { LauncherApi } from '../../core/src/launcher.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const launches: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'orbit-launch-layout-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    launcher: { createAdapter: () => ({
      list: async () => ['Notes', 'Browser', 'Music'].map((name, i) => ({ key: `registration-${i}`, name, revision: 'one' })),
      launch: async (app, authorize) => { authorize(); if (app.key === 'registration-1') throw new Error('crashed'); launches.push(app.key); } }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  const api = new LauncherApi(session);
  const apps = await api.list();
  return { api, launches, id: (name: string) => apps.find(a => a.name === name)!.appId, ids: apps.map(a => a.appId) };
}

test('pin, unpin and reorder keep a consistent favourites order', async t => {
  const { api, id } = await phone(t);
  await api.pin(id('Notes'));
  const pinned = await api.pin(id('Music'));
  assert.deepEqual(pinned, [id('Notes'), id('Music')]);
  assert.deepEqual(await api.reorder([id('Music'), id('Notes')]), [id('Music'), id('Notes')]);
  assert.deepEqual(await api.unpin(id('Music')), [id('Notes')]);
});

test('reorder refuses anything that is not a permutation of the current pins', async t => {
  const { api, id } = await phone(t);
  await api.pin(id('Notes')); await api.pin(id('Music'));
  await assert.rejects(() => api.reorder([id('Notes')]), CommandError);
  await assert.rejects(() => api.reorder([id('Notes'), id('Notes')]), CommandError);
  await assert.rejects(() => api.reorder([id('Notes'), id('Browser')]), CommandError);
  assert.deepEqual(await api.reorder([id('Notes'), id('Music')]), [id('Notes'), id('Music')], 'order untouched by the refused attempts');
});

test('a scene launches what it can and names the app that failed', async t => {
  const { api, launches, ids } = await phone(t);
  const scene = (await api.saveScene('All', ids))[0]!;
  const result = await api.launchScene(scene.id);
  assert.equal(result.launched, 2);
  assert.deepEqual(result.failed, ['Browser']);
  assert.deepEqual(launches.sort(), ['registration-0', 'registration-2']);
});

test('scenes can be renamed in place and deleted, and an unknown app id is refused', async t => {
  const { api, id } = await phone(t);
  const created = (await api.saveScene('Work', [id('Notes')]))[0]!;
  const renamed = await api.saveScene('Focus', [id('Notes'), id('Music')], created.id);
  assert.equal(renamed.length, 1, 'same scene, not a copy');
  assert.equal(renamed[0]!.name, 'Focus');
  await assert.rejects(() => api.saveScene('Bad', ['not-an-app']), CommandError);
  assert.deepEqual(await api.deleteScene(created.id), []);
});
