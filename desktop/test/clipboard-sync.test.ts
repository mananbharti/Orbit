/** Verifies Clipboard Sync ordering and authorization; depends on synthetic adapters and core fixtures; never reads or writes the OS clipboard. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ClipboardSync } from '../src/clipboard-sync/clipboard-sync.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import { clipboardSubscriptionSchema } from '../src/protocol/clipboard.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';
import { deferred, MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

function success(response: ResponseMessage): JsonValue {
  assert.equal(response.payload.ok, true);
  if (!response.payload.ok) throw new Error('Expected success');
  return response.payload.result;
}

function fixture(t: TestContext, now?: () => number) {
  const setup = core({ now });
  const adapter = new MemoryClipboard();
  const sync = new ClipboardSync(setup.registry, () => adapter, setup.log, 10);
  t.after(() => sync.stop());
  function connection() {
    const issued = setup.auth.issue(setup.credential)!;
    const abort = new AbortController();
    const events: { eventType: string; data: JsonValue }[] = [];
    const binding: CommandConnection = { id: randomUUID(), closed: abort.signal,
      isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken),
      publish: (eventType, data) => { if (binding.isAuthorized()) events.push({ eventType, data }); } };
    const command = (type: string, payload: JsonValue) => setup.router.dispatch(
      { version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, binding);
    return { abort, events, command,
      subscribe: async () => clipboardSubscriptionSchema.parse(success(await command('clipboard.subscribe', {}))) };
  }
  return { ...setup, adapter, sync, connection };
}

test('subscription is future-only, bounded text events suppress echoes, and unsubscribe stops polling', async t => {
  const { adapter, connection } = fixture(t);
  assert.equal(adapter.reads, 0);
  const a = connection();
  const subscription = await a.subscribe();
  assert.deepEqual(Object.keys(subscription).sort(), ['revision', 'subscriptionId']);
  await delay(30);
  assert.equal(a.events.length, 0);
  adapter.value = { kind: 'text', text: 'new desktop copy 雪😀' };
  await waitForClipboard(() => a.events.length === 1);
  assert.equal(a.events[0]?.eventType, 'clipboard.changed');
  assert.deepEqual(a.events[0]?.data, { ...subscription, revision: 1, text: 'new desktop copy 雪😀' });
  const response = success(await a.command('clipboard.write', { subscriptionId: subscription.subscriptionId,
    baseRevision: 1, text: 'new client copy' }));
  assert.deepEqual(response, { status: 'applied', revision: 2 });
  await delay(35);
  assert.equal(a.events.length, 1);
  assert.deepEqual(adapter.writes, ['new client copy']);
  success(await a.command('clipboard.unsubscribe', { subscriptionId: subscription.subscriptionId }));
  const reads = adapter.reads;
  adapter.value = { kind: 'text', text: 'offline desktop copy' };
  await delay(35);
  assert.equal(adapter.reads, reads);
  const next = await a.subscribe();
  assert.notEqual(next.subscriptionId, subscription.subscriptionId);
  assert.equal(a.events.length, 1);
});

test('a second connection of the same device cannot receive content or use another subscription', async t => {
  const { adapter, connection } = fixture(t);
  const a = connection();
  const b = connection();
  const subscription = await a.subscribe();
  const rejected = await b.command('clipboard.write', { subscriptionId: subscription.subscriptionId, baseRevision: 0, text: 'forged' });
  assert.deepEqual(rejected.payload, { ok: false, error: { code: 'CLIPBOARD_NOT_SUBSCRIBED' } });
  adapter.value = { kind: 'text', text: 'private clipboard' };
  await waitForClipboard(() => a.events.length === 1);
  assert.equal(b.events.length, 0);
  assert.equal(adapter.writes.length, 0);
  a.abort.abort();
  assert.deepEqual((await a.command('clipboard.subscribe', {})).payload, { ok: false, error: { code: 'UNAUTHENTICATED' } });
});

test('desktop ordering rejects concurrent or unobserved-local stale writes and logs metadata only', async t => {
  const { adapter, connection, log } = fixture(t);
  const a = connection();
  const b = connection();
  const sa = await a.subscribe();
  const sb = await b.subscribe();
  const results = await Promise.all([
    a.command('clipboard.write', { subscriptionId: sa.subscriptionId, baseRevision: 0, text: 'synthetic-secret-a' }),
    b.command('clipboard.write', { subscriptionId: sb.subscriptionId, baseRevision: 0, text: 'synthetic-secret-b' }),
  ]);
  assert.deepEqual(results.map(success), [{ status: 'applied', revision: 1 }, { status: 'conflict', revision: 1 }]);
  assert.equal(a.events.length, 0);
  assert.equal(b.events.length, 1);
  adapter.value = { kind: 'text', text: 'synthetic-secret-local' };
  assert.deepEqual(success(await a.command('clipboard.write', { subscriptionId: sa.subscriptionId,
    baseRevision: 1, text: 'synthetic-secret-stale' })), { status: 'conflict', revision: 2 });
  assert.deepEqual(adapter.writes, ['synthetic-secret-a']);
  assert.ok(log.snapshot().some(event => event.eventType === 'clipboard.conflict'));
  assert.equal(JSON.stringify(log.snapshot()).includes('synthetic-secret'), false);
});

for (const invalidation of ['disconnect', 'revoke', 'expire'] as const) {
  test(`authorization is rechecked after an OS read on ${invalidation}`, async t => {
    let now = Date.now();
    const { adapter, connection, revoke } = fixture(t, () => now);
    const a = connection();
    const subscription = await a.subscribe();
    const entered = deferred();
    const release = deferred();
    t.after(release.resolve);
    adapter.beforeRead = async () => { entered.resolve(); await release.promise; };
    const pending = a.command('clipboard.write', { subscriptionId: subscription.subscriptionId, baseRevision: 0, text: 'must not write' });
    await entered.promise;
    if (invalidation === 'disconnect') a.abort.abort();
    if (invalidation === 'revoke') revoke();
    if (invalidation === 'expire') now += 300_001;
    release.resolve();
    assert.deepEqual((await pending).payload, { ok: false, error: { code: 'UNAUTHENTICATED' } });
    assert.equal(adapter.writes.length, 0);
  });
}

test('unsupported/oversized changes emit metadata; a read failure disables subscriptions without leaking diagnostics', async t => {
  const { adapter, connection, log } = fixture(t);
  const a = connection();
  const subscription = await a.subscribe();
  for (const kind of ['unsupported', 'oversized'] as const) {
    adapter.value = { kind };
    await waitForClipboard(() => a.events.some(event => event.eventType === 'clipboard.status' &&
      (event.data as { status: string }).status === kind));
  }
  adapter.failRead = true;
  await waitForClipboard(() => a.events.length === 3);
  assert.equal((a.events[2]?.data as { status: string }).status, 'unavailable');
  assert.deepEqual((await a.command('clipboard.write', { subscriptionId: subscription.subscriptionId,
    baseRevision: 2, text: 'no write' })).payload, { ok: false, error: { code: 'CLIPBOARD_NOT_SUBSCRIBED' } });
  assert.equal(JSON.stringify(log.snapshot()).includes('sensitive'), false);
});

test('write failures remain safe and invalid payloads never reach the adapter', async t => {
  const { adapter, connection } = fixture(t);
  const a = connection();
  const subscription = await a.subscribe();
  for (const payload of [{ ...subscription, baseRevision: 0, text: 'extra-field' },
    { subscriptionId: subscription.subscriptionId, baseRevision: 0, text: '😀'.repeat(2049) },
    { subscriptionId: subscription.subscriptionId, baseRevision: -1, text: 'negative' }]) {
    assert.deepEqual((await a.command('clipboard.write', payload)).payload, { ok: false, error: { code: 'INVALID_PAYLOAD' } });
  }
  adapter.failWrite = true;
  assert.deepEqual((await a.command('clipboard.write', { subscriptionId: subscription.subscriptionId,
    baseRevision: 0, text: '' })).payload, { ok: false, error: { code: 'CLIPBOARD_UNAVAILABLE' } });
  assert.equal(adapter.writes.length, 0);
});
