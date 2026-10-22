/** Pins App Launcher guards that other launcher tests leave open: cursor validation, missing layout or scenes, busy refusal, local launches, bad catalog entries; depends on the real router and a synthetic adapter; never opens installed applications. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AppLauncher } from '../src/app-launcher/app-launcher.js';
import { LauncherLayout } from '../src/app-launcher/launcher-layout.js';
import { LauncherScenes } from '../src/app-launcher/launcher-scenes.js';
import { appPageSchema, APP_PAGE_SIZE } from '../src/protocol/app-launcher.js';
import type { NativeApp, AppLauncherAdapter } from '../src/os-integration/app-launcher.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

class FakeLauncher implements AppLauncherAdapter {
  apps: NativeApp[] = [];
  launched: string[] = [];
  failing = new Set<string>();
  beforeList?: () => Promise<void>;
  icon?: (app: NativeApp) => Promise<string | null>;
  async list(): Promise<NativeApp[]> { await this.beforeList?.(); return this.apps.map(app => ({ ...app })); }
  async launch(app: NativeApp, authorize: () => void): Promise<void> {
    authorize();
    if (this.failing.has(app.name)) throw new Error('native failure');
    this.launched.push(app.name);
  }
}
const named = (count: number): NativeApp[] => Array.from({ length: count }, (_, i) => ({ key: `/k/${String(i).padStart(4, '0')}`, name: `App ${i}`, revision: 'r' }));
function fixture(t: TestContext, options: { layout?: boolean; scenes?: boolean; apps?: NativeApp[]; secretPath?: string } = {}) {
  const setup = core();
  const adapter = new FakeLauncher();
  adapter.apps = options.apps ?? named(3);
  const launcher = new AppLauncher(setup.registry, () => adapter, options.layout ? new LauncherLayout() : undefined, options.secretPath, options.scenes ? new LauncherScenes() : undefined);
  t.after(() => launcher.stop());
  const issued = setup.auth.issue(setup.credential)!;
  const closed = new AbortController();
  const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => !closed.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection);
  return { adapter, launcher, closed, command };
}
const ok = (r: ResponseMessage): JsonValue => { assert.ok(r.payload.ok, JSON.stringify(r.payload)); return r.payload.result; };
const fails = (r: ResponseMessage, code: string): void => assert.deepEqual(r.payload, { ok: false, error: { code } });
const list = async (f: ReturnType<typeof fixture>) => appPageSchema.parse(ok(await f.command('launcher.list', {})));

test('page cursors must carry the current revision, a page-aligned positive index inside the catalog', async t => {
  const f = fixture(t, { apps: named(APP_PAGE_SIZE * 2 + 1) });
  const first = await list(f);
  const rev = first.catalogRevision;
  assert.ok(first.nextCursor);
  fails(await f.command('launcher.list', { cursor: `${randomUUID()}:${APP_PAGE_SIZE}` }), 'LAUNCHER_STALE_CATALOG');
  fails(await f.command('launcher.list', { cursor: `${rev}:0` }), 'LAUNCHER_STALE_CATALOG');
  fails(await f.command('launcher.list', { cursor: `${rev}:5` }), 'LAUNCHER_STALE_CATALOG');
  fails(await f.command('launcher.list', { cursor: `${rev}:${APP_PAGE_SIZE * 3}` }), 'LAUNCHER_STALE_CATALOG');
  const last = appPageSchema.parse(ok(await f.command('launcher.list', { cursor: `${rev}:${APP_PAGE_SIZE * 2}` })));
  assert.equal(last.apps.length, 1);
});

test('without a layout or scenes store, pin, unpin, reorder and every scene command say LAUNCHER_UNAVAILABLE', async t => {
  const f = fixture(t);
  const page = await list(f);
  const id = page.apps[0]!.appId;
  const sceneId = randomUUID();
  for (const [type, payload] of [['launcher.pin', { appId: id }], ['launcher.unpin', { appId: id }], ['launcher.reorder', { appIds: [id] }],
    ['launcher.scenes', {}], ['launcher.scene.save', { name: 'x', appIds: [id] }], ['launcher.scene.delete', { id: sceneId }], ['launcher.scene.launch', { id: sceneId }]] as [string, JsonValue][]) {
    fails(await f.command(type, payload), 'LAUNCHER_UNAVAILABLE');
  }
});

test('pinning an app that is not in the catalog is refused', async t => {
  const f = fixture(t, { layout: true });
  await list(f);
  fails(await f.command('launcher.pin', { appId: 'a'.repeat(64) }), 'LAUNCHER_NOT_FOUND');
});

test('a scene can be saved right after a restart, but not with an unknown app', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-launcher-guards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secretPath = join(dir, 'secret');
  const before = fixture(t, { secretPath });
  const id = (await list(before)).apps[0]!.appId;
  const restarted = fixture(t, { scenes: true, secretPath });
  // No list call yet: save must refresh the catalog itself, or the known id would fail as NOT_FOUND.
  const saved = ok(await restarted.command('launcher.scene.save', { name: 'Work', appIds: [id] })) as { scenes: unknown[] };
  assert.equal(saved.scenes.length, 1);
  fails(await restarted.command('launcher.scene.save', { name: 'Ghost', appIds: ['b'.repeat(64)] }), 'LAUNCHER_NOT_FOUND');
});

test('scene launch counts launched apps and names failures and removed apps; one failure never blocks the rest', async t => {
  const f = fixture(t, { scenes: true });
  const page = await list(f);
  const ids = page.apps.map(a => a.appId);
  ok(await f.command('launcher.scene.save', { name: 'Mix', appIds: ids }));
  const sceneId = (ok(await f.command('launcher.scenes', {})) as { scenes: { id: string }[] }).scenes[0]!.id;
  f.adapter.failing.add('App 1');
  assert.deepEqual(ok(await f.command('launcher.scene.launch', { id: sceneId })), { launched: 2, failed: ['App 1'] });
  assert.deepEqual(f.adapter.launched, ['App 0', 'App 2']);
  f.adapter.apps = f.adapter.apps.filter(a => a.name !== 'App 2');
  assert.deepEqual(ok(await f.command('launcher.scene.launch', { id: sceneId })), { launched: 1, failed: ['App 1', '(removed app)'] });
});

test('a second request while native discovery runs is BUSY, then the slot frees', async t => {
  const f = fixture(t);
  let release!: () => void;
  f.adapter.beforeList = () => new Promise<void>(resolve => { release = resolve; });
  const first = f.command('launcher.list', {});
  for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  fails(await f.command('launcher.list', {}), 'BUSY');
  release();
  ok(await first);
  f.adapter.beforeList = undefined;
  ok(await f.command('launcher.list', {}));
});

test('a connection that closes during discovery gets UNAUTHENTICATED instead of a catalog', async t => {
  const f = fixture(t);
  f.adapter.beforeList = async () => { f.closed.abort(); };
  fails(await f.command('launcher.list', {}), 'UNAUTHENTICATED');
});

test('catalog entries with an invalid name are skipped; duplicate keys make the catalog unavailable', async t => {
  const f = fixture(t);
  f.adapter.apps = [{ key: '/a', name: '', revision: 'r' }, { key: '/b', name: 'Fine', revision: 'r' }];
  assert.deepEqual((await list(f)).apps.map(a => a.name), ['Fine']);
  f.adapter.apps = [{ key: '/a', name: 'One', revision: 'r' }, { key: '/a', name: 'Two', revision: 'r' }];
  fails(await f.command('launcher.list', {}), 'LAUNCHER_UNAVAILABLE');
});

test('computer-initiated launches refresh an empty catalog, report a vanished app, and keep launching a scene past failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-launcher-guards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secretPath = join(dir, 'secret');
  const f = fixture(t, { scenes: true, secretPath });
  const ids = (await list(f)).apps.map(a => a.appId);
  ok(await f.command('launcher.scene.save', { name: 'Local', appIds: ids }));
  const sceneId = (ok(await f.command('launcher.scenes', {})) as { scenes: { id: string }[] }).scenes[0]!.id;
  const restarted = fixture(t, { secretPath });
  await restarted.launcher.launchLocal(ids[0]!);
  assert.deepEqual(restarted.adapter.launched, ['App 0'], 'launched without a prior list call');
  await assert.rejects(restarted.launcher.launchLocal('c'.repeat(64)), /AUTOMATION_APP_GONE/);
  await assert.rejects(f.launcher.launchSceneLocal(randomUUID()), /AUTOMATION_SCENE_GONE/);
  f.adapter.failing.add('App 0');
  await f.launcher.launchSceneLocal(sceneId);
  assert.deepEqual(f.adapter.launched, ['App 1', 'App 2']);
});

test('an icon that fails to load becomes null and the rest of the batch still returns', async t => {
  const f = fixture(t);
  const page = await list(f);
  f.adapter.icon = async app => { if (app.name === 'App 1') throw new Error('icon decode failed'); return Buffer.from('png').toString('base64'); };
  const ids = page.apps.map(a => a.appId);
  const { icons } = ok(await f.command('launcher.icons', { appIds: ids, catalogRevision: page.catalogRevision })) as { icons: Record<string, string | null> };
  assert.equal(icons[ids[0]!], Buffer.from('png').toString('base64'));
  assert.equal(icons[ids[1]!], null);
  assert.equal(icons[ids[2]!], Buffer.from('png').toString('base64'));
});
