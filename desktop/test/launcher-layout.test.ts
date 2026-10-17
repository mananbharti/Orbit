/** Tests pinned-favourite commands, layout persistence and app-id stability; depends on a temp directory and a synthetic adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AppLauncher } from '../src/app-launcher/app-launcher.js';
import { LauncherLayout } from '../src/app-launcher/launcher-layout.js';
import { appPageSchema } from '../src/protocol/app-launcher.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';
import { MemoryLauncher } from './launcher.test.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = core(); const adapter = new MemoryLauncher();
  const layoutPath = join(root, 'launcher-pins.json'); const secretPath = join(root, 'launcher-secret');
  const launcher = new AppLauncher(setup.registry, () => adapter, new LauncherLayout(layoutPath), secretPath);
  t.after(() => launcher.stop());
  const issued = setup.auth.issue(setup.credential)!;
  const closed = new AbortController();
  const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => !closed.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch({ version: 1, type, payload, requestId: randomUUID() }, issued.sessionToken, connection);
  return { ...setup, adapter, launcher, closed, command, layoutPath, secretPath };
}
function result(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function error(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }

test('pins surface on every catalog page and pin/unpin/reorder update the layout', async t => {
  const { adapter, command } = fixture(t);
  adapter.apps = [{ key: '/app/one', name: 'One', revision: '1' }, { key: '/app/two', name: 'Two', revision: '1' }, { key: '/app/three', name: 'Three', revision: '1' },
    ...Array.from({ length: 33 }, (_, index) => ({ key: `/app/filler-${index}`, name: `Filler ${index}`, revision: '1' }))];
  const page = appPageSchema.parse(result(await command('launcher.list', {})));
  assert.deepEqual(page.pinned, []);
  const pageTwo = appPageSchema.parse(result(await command('launcher.list', { cursor: page.nextCursor! })));
  const named = Object.fromEntries([...page.apps, ...pageTwo.apps].map(app => [app.name, app.appId]));
  const [one, two, three] = ['One', 'Two', 'Three'].map(name => named[name]!) as [string, string, string];
  assert.deepEqual(result(await command('launcher.pin', { appId: three })), { pinned: [three] });
  assert.deepEqual(result(await command('launcher.pin', { appId: one })), { pinned: [three, one] });
  error(await command('launcher.pin', { appId: 'f'.repeat(64) }), 'LAUNCHER_NOT_FOUND');
  const pinnedPage = appPageSchema.parse(result(await command('launcher.list', { cursor: `${page.catalogRevision}:32` })));
  assert.deepEqual(pinnedPage.pinned, [three, one]);
  assert.deepEqual(result(await command('launcher.reorder', { appIds: [one, three] })), { pinned: [one, three] });
  error(await command('launcher.reorder', { appIds: [one, two] }), 'LAUNCHER_STALE_LAYOUT');
  assert.deepEqual(result(await command('launcher.unpin', { appId: one })), { pinned: [three] });
});

test('the layout survives a restart and app ids stay stable, so pins never dangle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layoutPath = join(root, 'launcher-pins.json'); const secretPath = join(root, 'launcher-secret');
  const first = new LauncherLayout(layoutPath);
  first.pin('a'.repeat(64)); first.pin('b'.repeat(64));
  const reopened = new LauncherLayout(layoutPath);
  assert.deepEqual(reopened.list(), ['a'.repeat(64), 'b'.repeat(64)]);
  reopened.unpin('a'.repeat(64));
  assert.deepEqual(new LauncherLayout(layoutPath).list(), ['b'.repeat(64)]);
  const idOf = async () => {
    const setup = core(); const adapter = new MemoryLauncher();
    const launcher = new AppLauncher(setup.registry, () => adapter, undefined, secretPath);
    t.after(() => launcher.stop());
    const issued = setup.auth.issue(setup.credential)!;
    const closed = new AbortController();
    const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => true, publish: () => {} };
    const response = await setup.router.dispatch({ version: 1, type: 'launcher.list', payload: {}, requestId: randomUUID() }, issued.sessionToken, connection);
    assert.ok(response.payload.ok);
    return (response.payload.result as { apps: { appId: string }[] }).apps[0]!.appId;
  };
  assert.equal(await idOf(), await idOf());
  assert.match(readFileSync(secretPath, 'utf8'), /^[a-f0-9]{64}$/);
});

test('a corrupt layout file starts empty instead of crashing the service', t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-layout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'launcher-pins.json');
  writeFileSync(path, 'not json at all', 'utf8');
  assert.deepEqual(new LauncherLayout(path).list(), []);
});
