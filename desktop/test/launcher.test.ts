/** Tests authenticated catalogs and activation failure paths; depends on the real router and a synthetic adapter; never opens installed applications. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { AppLauncher } from '../src/app-launcher/app-launcher.js';
import { appPageSchema, APP_PAGE_SIZE, MAX_APPS } from '../src/protocol/app-launcher.js';
import { ProtocolError } from '../src/protocol/errors.js';
import type { NativeApp, AppLauncherAdapter } from '../src/os-integration/app-launcher.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';

export class MemoryLauncher implements AppLauncherAdapter {
  apps: NativeApp[] = [{ key: '/private/app-registration', name: 'Synthetic App', revision: 'one' }];
  launches = 0;
  beforeList?: () => Promise<void>;
  beforeLaunch?: () => Promise<void>;
  async list(): Promise<NativeApp[]> { await this.beforeList?.(); return this.apps.map(app => ({ ...app })); }
  async launch(_app: NativeApp, authorize: () => void): Promise<void> { await this.beforeLaunch?.(); authorize(); this.launches++; }
}
function fixture(t: TestContext) {
  const setup = core(); const adapter = new MemoryLauncher();
  const launcher = new AppLauncher(setup.registry, () => adapter);
  t.after(() => launcher.stop());
  const issued = setup.auth.issue(setup.credential)!;
  const closed = new AbortController();
  const connection = { id: randomUUID(), closed: closed.signal, isAuthorized: () => !closed.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue, requestId = randomUUID()) => setup.router.dispatch({ version: 1, type, payload, requestId }, issued.sessionToken, connection);
  return { ...setup, adapter, launcher, closed, command };
}
function result(response: ResponseMessage): JsonValue { assert.ok(response.payload.ok); return response.payload.result; }
function error(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }

test('catalogs use opaque IDs and bounded pages; launch logs omit names, registrations and revisions', async t => {
  const { adapter, command, log } = fixture(t);
  adapter.apps = Array.from({ length: APP_PAGE_SIZE + 1 }, (_, index) => ({ key: `/private/path-${index}`, name: `Synthetic ${index}`, revision: 'private-revision' }));
  const first = appPageSchema.parse(result(await command('launcher.list', {})));
  assert.equal(first.apps.length, APP_PAGE_SIZE); assert.ok(first.nextCursor);
  const second = appPageSchema.parse(result(await command('launcher.list', { cursor: first.nextCursor })));
  assert.equal(second.apps.length, 1); assert.equal(second.nextCursor, null);
  const requestId = randomUUID(); const payload = { appId: first.apps[0]!.appId, catalogRevision: first.catalogRevision };
  assert.deepEqual(result(await command('launcher.launch', payload, requestId)), { status: 'requested' });
  error(await command('launcher.launch', payload, requestId), 'DUPLICATE_REQUEST');
  assert.equal(adapter.launches, 1);
  const metadata = JSON.stringify(log.snapshot());
  for (const secret of [adapter.apps[0]!.name, adapter.apps[0]!.key, 'private-revision', payload.appId]) assert.equal(metadata.includes(secret), false);
});

test('changed or removed registrations invalidate the catalog before activation', async t => {
  const { adapter, command } = fixture(t);
  const first = appPageSchema.parse(result(await command('launcher.list', {})));
  adapter.apps[0]!.revision = 'changed target';
  error(await command('launcher.launch', { appId: first.apps[0]!.appId, catalogRevision: first.catalogRevision }), 'LAUNCHER_STALE_CATALOG');
  const refreshed = appPageSchema.parse(result(await command('launcher.list', {})));
  assert.equal(first.apps[0]!.appId, refreshed.apps[0]!.appId);
  adapter.apps = [];
  error(await command('launcher.launch', { appId: refreshed.apps[0]!.appId, catalogRevision: refreshed.catalogRevision }), 'LAUNCHER_STALE_CATALOG');
  assert.equal(adapter.launches, 0);
});

test('strict launcher payloads reject paths, arguments, tokens, unknown IDs and malformed cursors', async t => {
  const { command, adapter } = fixture(t);
  const page = appPageSchema.parse(result(await command('launcher.list', {})));
  const valid = { appId: page.apps[0]!.appId, catalogRevision: page.catalogRevision };
  const extras: Record<string, JsonValue>[] = [{ path: '/bin/sh' }, { arguments: ['-c', 'something'] }, { token: 'secret' }, { url: 'https://example.invalid' }];
  for (const extra of extras) {
    error(await command('launcher.launch', { ...valid, ...extra }), 'INVALID_PAYLOAD');
  }
  error(await command('launcher.launch', { ...valid, appId: '0'.repeat(64) }), 'LAUNCHER_NOT_FOUND');
  error(await command('launcher.list', { cursor: '../../secret' }), 'INVALID_PAYLOAD');
  assert.equal(adapter.launches, 0);
});

for (const loss of ['disconnect', 'revoke', 'stop'] as const) {
  test(`${loss} during native preparation prevents activation`, async t => {
    const { command, adapter, closed, revoke, launcher } = fixture(t);
    const page = appPageSchema.parse(result(await command('launcher.list', {})));
    adapter.beforeLaunch = async () => {
      if (loss === 'disconnect') closed.abort();
      if (loss === 'revoke') revoke();
      if (loss === 'stop') void launcher.stop();
    };
    error(await command('launcher.launch', { appId: page.apps[0]!.appId, catalogRevision: page.catalogRevision }), 'UNAUTHENTICATED');
    assert.equal(adapter.launches, 0);
  });
}

test('native failures are redacted, limits fail explicitly, and the module remains usable', async t => {
  const { command, adapter } = fixture(t);
  adapter.beforeList = async () => { throw new Error('private native diagnostics'); };
  error(await command('launcher.list', {}), 'LAUNCHER_UNAVAILABLE');
  adapter.beforeList = undefined;
  adapter.apps = Array.from({ length: MAX_APPS + 1 }, (_, index) => ({ key: String(index), name: 'App', revision: 'one' }));
  error(await command('launcher.list', {}), 'LAUNCHER_LIMIT');
  adapter.apps = [{ key: 'app', name: 'App', revision: 'one' }];
  const page = appPageSchema.parse(result(await command('launcher.list', {})));
  adapter.beforeLaunch = async () => { throw new ProtocolError('LAUNCHER_UNKNOWN_OUTCOME'); };
  error(await command('launcher.launch', { appId: page.apps[0]!.appId, catalogRevision: page.catalogRevision }), 'LAUNCHER_UNKNOWN_OUTCOME');
});
