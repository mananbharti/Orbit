/** Tests scene save/delete/launch commands and persistence; depends on a temp directory and a synthetic adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AppLauncher } from '../src/app-launcher/app-launcher.js';
import { LauncherScenes } from '../src/app-launcher/launcher-scenes.js';
import type { AppLauncherAdapter, NativeApp } from '../src/os-integration/app-launcher.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

class SceneAdapter implements AppLauncherAdapter {
  apps: NativeApp[] = [{ key: '/app/one', name: 'One', revision: '1' }, { key: '/app/two', name: 'Two', revision: '1' }, { key: '/app/three', name: 'Three', revision: '1' }];
  launched: string[] = [];
  failOn = new Set<string>();
  async list(): Promise<NativeApp[]> { return this.apps.map(app => ({ ...app })); }
  async launch(app: NativeApp, authorize: () => void): Promise<void> { authorize(); if (this.failOn.has(app.key)) throw new Error('denied'); this.launched.push(app.key); }
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-scenes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = core(); const adapter = new SceneAdapter();
  const scenesPath = join(root, 'launcher-scenes.json');
  const launcher = new AppLauncher(setup.registry, () => adapter, undefined, undefined, new LauncherScenes(scenesPath));
  t.after(() => launcher.stop());
  const issued = setup.auth.issue(setup.credential)!;
  const closed = new AbortController();
  const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => !closed.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection);
  return { ...setup, adapter, launcher, command, scenesPath };
}
function result(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function error(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }
async function ids(f: ReturnType<typeof fixture>): Promise<[string, string, string]> {
  const page = result(await f.command('launcher.list', {})) as { apps: { appId: string }[] };
  return page.apps.map(app => app.appId) as [string, string, string];
}

test('scenes save, list, rename and delete; names dedupe case-insensitively', async t => {
  const f = fixture(t);
  const [one, two] = await ids(f);
  const saved = result(await f.command('launcher.scene.save', { name: 'Work', appIds: [one, two] })) as { scenes: { id: string; name: string }[] };
  assert.equal(saved.scenes.length, 1);
  const id = saved.scenes[0]!.id;
  error(await f.command('launcher.scene.save', { name: 'work', appIds: [one] }), 'LAUNCHER_SCENE_CONFLICT');
  error(await f.command('launcher.scene.save', { name: 'Bad', appIds: ['f'.repeat(64)] }), 'LAUNCHER_NOT_FOUND');
  const renamed = result(await f.command('launcher.scene.save', { id, name: 'Focus', appIds: [one] })) as { scenes: { name: string; appIds: string[] }[] };
  assert.equal(renamed.scenes[0]!.name, 'Focus');
  assert.deepEqual(renamed.scenes[0]!.appIds, [one]);
  error(await f.command('launcher.scene.save', { id: randomUUID(), name: 'Ghost', appIds: [one] }), 'LAUNCHER_NOT_FOUND');
  const listed = result(await f.command('launcher.scenes', {})) as { scenes: { name: string }[] };
  assert.equal(listed.scenes[0]!.name, 'Focus');
  const removed = result(await f.command('launcher.scene.delete', { id })) as { scenes: unknown[] };
  assert.equal(removed.scenes.length, 0);
});

test('launching a scene opens each app in order and one failure never blocks the rest', async t => {
  const f = fixture(t);
  const [one, two, three] = await ids(f);
  const saved = result(await f.command('launcher.scene.save', { name: 'Work', appIds: [one, two, three] })) as { scenes: { id: string }[] };
  f.adapter.failOn.add('/app/two');
  const launched = result(await f.command('launcher.scene.launch', { id: saved.scenes[0]!.id })) as { launched: number; failed: string[] };
  assert.equal(launched.launched, 2);
  assert.deepEqual(launched.failed, ['Two']);
  assert.deepEqual(f.adapter.launched, ['/app/one', '/app/three']);
  error(await f.command('launcher.scene.launch', { id: randomUUID() }), 'LAUNCHER_NOT_FOUND');
});

test('scenes survive a restart because app ids are stable', t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-scenes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'launcher-scenes.json');
  const first = new LauncherScenes(path);
  first.save('Work', ['a'.repeat(64)]);
  const reopened = new LauncherScenes(path);
  assert.equal(reopened.list()[0]!.name, 'Work');
  writeFileSync(path, 'garbage', 'utf8');
  assert.deepEqual(new LauncherScenes(path).list(), []);
});
