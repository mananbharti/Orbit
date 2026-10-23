/** Clipboard Sync edges the main suites do not pin; same synthetic fixtures. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { ClipboardSync } from '../src/clipboard-sync/clipboard-sync.js';
import { ClipboardHistory } from '../src/clipboard-sync/clipboard-history.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import { clipboardSubscriptionSchema } from '../src/protocol/clipboard.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';
import { MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

function success(response: ResponseMessage): JsonValue {
  assert.equal(response.payload.ok, true);
  if (!response.payload.ok) throw new Error('Expected success');
  return response.payload.result;
}
function fail(response: ResponseMessage, code: string): void { assert.deepEqual(response.payload, { ok: false, error: { code } }); }

function fixture(t: TestContext, withHistory = true) {
  const setup = core();
  const adapter = new MemoryClipboard();
  const history = withHistory ? new ClipboardHistory() : undefined;
  const sync = new ClipboardSync(setup.registry, () => adapter, setup.log, 10, history);
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
  return { ...setup, adapter, sync, history, connection };
}

test('writing the text already on the clipboard is unchanged and never touches the OS', async t => {
  const { adapter, connection } = fixture(t);
  const a = connection();
  const sub = await a.subscribe();
  const response = success(await a.command('clipboard.write', { subscriptionId: sub.subscriptionId,
    baseRevision: sub.revision, text: 'initial synthetic clipboard' }));
  assert.deepEqual(response, { status: 'unchanged', revision: sub.revision });
  assert.deepEqual(adapter.writes, []);
});
test('history remembers who each clip came from', async t => {
  const { adapter, history, connection } = fixture(t);
  const a = connection();
  const sub = await a.subscribe();
  success(await a.command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: sub.revision, text: 'from the phone' }));
  adapter.value = { kind: 'text', text: 'from the pc' };
  await waitForClipboard(() => a.events.length === 1);
  const page = history!.page();
  assert.deepEqual(page.entries.map(e => [e.text, e.source]), [['from the pc', 'pc'], ['from the phone', 'phone']]);
});
test('apply publishes the clip to the applying phone itself', async t => {
  const { adapter, history, connection } = fixture(t);
  const a = connection();
  const sub = await a.subscribe();
  adapter.value = { kind: 'text', text: 'a desktop clip' };
  await waitForClipboard(() => a.events.length === 1);
  const entry = history!.page().entries[0]!;
  adapter.value = { kind: 'text', text: 'a newer desktop clip' };
  await waitForClipboard(() => a.events.length === 2);
  success(await a.command('clipboard.apply', { subscriptionId: sub.subscriptionId, historyId: entry.id }));
  assert.deepEqual(adapter.writes, ['a desktop clip']);
  await waitForClipboard(() => a.events.length === 3);
  assert.equal(a.events[2]!.eventType, 'clipboard.changed');
  assert.equal((a.events[2]!.data as { text: string }).text, 'a desktop clip', 'the applying phone is told, unlike a typed write');
});
test('unsubscribing while the pre-write read is in flight stops the write', async t => {
  const { adapter, connection } = fixture(t);
  const a = connection();
  const sub = await a.subscribe();
  let release!: () => void;
  adapter.beforeRead = () => new Promise<void>(r => { release = r; });
  const writing = a.command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: sub.revision, text: 'too late' });
  await delay(20);
  success(await a.command('clipboard.unsubscribe', { subscriptionId: sub.subscriptionId }));
  release();
  fail(await writing, 'CLIPBOARD_NOT_SUBSCRIBED');
  assert.deepEqual(adapter.writes, []);
});
test('a subscription stays future-only across an availability outage', async t => {
  const { adapter, connection } = fixture(t);
  const a = connection();
  await a.subscribe();
  await waitForClipboard(() => adapter.reads > 0);
  adapter.failRead = true;
  await waitForClipboard(() => a.events.some(e => e.eventType === 'clipboard.status'));
  adapter.failRead = false;
  adapter.value = { kind: 'text', text: 'copied during the outage' };
  const again = await a.subscribe();
  await delay(40);
  assert.equal(a.events.filter(e => e.eventType === 'clipboard.changed').length, 0,
    'the clip from during the outage is a baseline, not an event');
  assert.equal(again.revision, 0);
});
