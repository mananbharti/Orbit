/** Unit-pins LauncherClient pagination guards with a stub channel; depends only on the protocol schemas. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { LauncherClient } from '../src/integration-client/launcher-client.js';
import type { OrbitClient } from '../src/integration-client/orbit-client.js';
import { success } from '../src/protocol/messages.js';

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
const app = (seed: string) => ({ appId: hex(seed), name: `App ${seed}` });
const page = (revision: string, apps: { appId: string; name: string }[], nextCursor: string | null) =>
  ({ catalogRevision: revision, apps, nextCursor, pinned: [] });

function stubClient(handler: (cursor?: string) => unknown) {
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    scheduledCommand: async (_type: string, payload: Record<string, unknown>) =>
      success('r', handler(payload.cursor as string | undefined) as never),
  });
  return { client: client as unknown as OrbitClient, emitter };
}

test('a catalog revision change mid-pagination is rejected as stale', async () => {
  const revision = randomUUID();
  const { client } = stubClient(cursor => cursor
    ? page(randomUUID(), [app('b')], null) // second page under a different revision
    : page(revision, [app('a')], 'c1'));
  const launcher = new LauncherClient(client);
  await assert.rejects(launcher.list(), /LAUNCHER_STALE_CATALOG/);
  launcher.stop();
});

test('a repeating cursor is rejected as a limit violation instead of looping forever', async () => {
  const revision = randomUUID();
  const { client } = stubClient(() => page(revision, [app('a')], 'same-cursor'));
  const launcher = new LauncherClient(client);
  await assert.rejects(launcher.list(), /LAUNCHER_LIMIT/);
  launcher.stop();
});

test('accumulating beyond MAX_APPS across pages is rejected as a limit violation', async () => {
  const revision = randomUUID();
  let calls = 0;
  const { client } = stubClient(() => {
    calls++;
    return page(revision, Array.from({ length: 32 }, (_, i) => app(`${calls}-${i}`)), calls < 70 ? `c${calls}` : null);
  });
  const launcher = new LauncherClient(client);
  await assert.rejects(launcher.list(), /LAUNCHER_LIMIT/);
  launcher.stop();
});

test('a connection reset mid-list aborts the stale list instead of mixing catalogs', async () => {
  const revision = randomUUID();
  let emitterRef: EventEmitter | undefined;
  const { client, emitter } = stubClient(cursor => {
    if (cursor) emitterRef!.emit('status', 'reconnecting'); // connection dropped between pages
    return page(revision, [app(cursor ? 'b' : 'a')], cursor ? null : 'c1');
  });
  emitterRef = emitter;
  const launcher = new LauncherClient(client);
  await assert.rejects(launcher.list(), /Connection changed; list again/);
  launcher.stop();
});

test('a clean two-page list returns every app, and launch refuses unknown apps', async () => {
  const revision = randomUUID();
  const { client } = stubClient(cursor => cursor
    ? page(revision, [app('b')], null)
    : page(revision, [app('a')], 'c1'));
  const launcher = new LauncherClient(client);
  const apps = await launcher.list();
  assert.equal(apps.length, 2);
  await assert.rejects(launcher.launch(hex('unknown')), /LAUNCHER_NOT_FOUND/);
  launcher.stop();
});
