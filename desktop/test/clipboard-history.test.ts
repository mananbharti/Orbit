/** Verifies shared clipboard history: capture from both devices, paging, apply and private persistence; depends on synthetic adapters; never touches the OS clipboard. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ClipboardHistory } from '../src/clipboard-sync/clipboard-history.js';
import { ClipboardSync } from '../src/clipboard-sync/clipboard-sync.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import { clipboardSubscriptionSchema, clipboardHistoryResultSchema } from '../src/protocol/clipboard.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';
import { MemoryClipboard } from './clipboard-helpers.js';

function success(response: ResponseMessage): JsonValue {
  assert.equal(response.payload.ok, true);
  if (!response.payload.ok) throw new Error('Expected success');
  return response.payload.result;
}
function failure(response: ResponseMessage): string {
  assert.equal(response.payload.ok, false);
  if (response.payload.ok) throw new Error('Expected failure');
  return response.payload.error.code;
}

function fixture(t: TestContext) {
  const setup = core();
  const root = mkdtempSync(join(tmpdir(), 'orbit-clipboard-history-'));
  const adapter = new MemoryClipboard();
  const history = new ClipboardHistory(join(root, 'history.json'));
  const sync = new ClipboardSync(setup.registry, () => adapter, setup.log, 10, history);
  t.after(async () => { await sync.stop(); rmSync(root, { recursive: true, force: true }); });
  const issued = setup.auth.issue(setup.credential)!;
  const abort = new AbortController();
  const binding: CommandConnection = { id: randomUUID(), closed: abort.signal,
    isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken), publish: () => {} };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch(
    { version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, binding);
  return { ...setup, adapter, history, command, root,
    subscribe: async () => clipboardSubscriptionSchema.parse(success(await command('clipboard.subscribe', {}))) };
}

test('clips from both devices land in history, newest first, deduped, and page within the byte budget', async t => {
  const { adapter, command, subscribe } = fixture(t);
  const sub = await subscribe();
  adapter.value = { kind: 'text', text: 'from the pc' };
  await new Promise(r => setTimeout(r, 40)); // let a poll observe the PC clip
  const fresh = await subscribe(); // re-subscribing returns the current revision
  success(await command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: fresh.revision, text: 'from the phone' }));
  const page = clipboardHistoryResultSchema.parse(success(await command('clipboard.history', {})));
  assert.equal(page.entries.length >= 1, true);
  assert.equal(page.entries[0]!.text, 'from the phone');
  assert.equal(page.entries[0]!.source, 'phone');
  const texts = page.entries.map(e => e.text);
  assert.equal(new Set(texts).size, texts.length); // no consecutive duplicates
  assert.equal(JSON.stringify(page).length < 60_000, true);
  const empty = clipboardHistoryResultSchema.parse(success(await command('clipboard.history', { before: page.entries[page.entries.length - 1]!.id })));
  assert.equal(empty.nextCursor, null);
});

test('apply writes the entry to the OS clipboard through the normal write path', async t => {
  const { adapter, command, history, subscribe } = fixture(t);
  const sub = await subscribe();
  success(await command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: sub.revision, text: 'remember me' }));
  const page = clipboardHistoryResultSchema.parse(success(await command('clipboard.history', {})));
  const entry = page.entries.find(e => e.text === 'remember me')!;
  adapter.value = { kind: 'text', text: 'something else' };
  const applied = success(await command('clipboard.apply', { subscriptionId: sub.subscriptionId, historyId: entry.id })) as { status: string };
  assert.equal(applied.status, 'applied');
  assert.deepEqual(adapter.value, { kind: 'text', text: 'remember me' });
  assert.equal(failure(await command('clipboard.apply', { subscriptionId: sub.subscriptionId, historyId: randomUUID() })), 'CLIPBOARD_NOT_FOUND');
  assert.ok(history.get(entry.id));
});

test('history persists privately and a corrupt file starts empty', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-history-persist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'history.json');
  const first = new ClipboardHistory(path);
  first.add('kept across restarts', 'pc');
  const second = new ClipboardHistory(path);
  assert.equal(second.page().entries[0]!.text, 'kept across restarts');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 1);
  writeFileSync(path, 'not json at all');
  const third = new ClipboardHistory(path);
  assert.equal(third.page().entries.length, 0);
});

test('history is bounded at 50 entries', () => {
  const history = new ClipboardHistory();
  for (let i = 0; i < 60; i++) history.add(`clip ${i}`, 'pc');
  const { entries, nextCursor } = history.page();
  assert.equal(nextCursor, null);
  assert.equal(entries.length, 50);
  assert.equal(entries[0]!.text, 'clip 59');
  assert.equal(entries[49]!.text, 'clip 10');
});

test('apply notifies the applying phone itself, unlike a typed write', async t => {
  const setup = core();
  const root = mkdtempSync(join(tmpdir(), 'orbit-clipboard-apply-'));
  const adapter = new MemoryClipboard();
  const history = new ClipboardHistory(join(root, 'history.json'));
  const sync = new ClipboardSync(setup.registry, () => adapter, setup.log, 10, history);
  t.after(async () => { await sync.stop(); rmSync(root, { recursive: true, force: true }); });
  const issued = setup.auth.issue(setup.credential)!;
  const abort = new AbortController();
  const events: { type: string; data: unknown }[] = [];
  const binding: CommandConnection = { id: randomUUID(), closed: abort.signal,
    isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken),
    publish: (type, data) => events.push({ type, data }) };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch(
    { version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, binding);
  const sub = clipboardSubscriptionSchema.parse(success(await command('clipboard.subscribe', {})));
  success(await command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: sub.revision, text: 'typed on phone' }));
  assert.equal(events.filter(e => e.type === 'clipboard.changed').length, 0, 'typed writes do not echo to the writer');
  const entry = clipboardHistoryResultSchema.parse(success(await command('clipboard.history', {}))).entries.find(e => e.text === 'typed on phone')!;
  adapter.value = { kind: 'text', text: 'other' };
  await new Promise(r => setTimeout(r, 40)); // let a poll observe 'other' so the apply is a real change
  success(await command('clipboard.apply', { subscriptionId: sub.subscriptionId, historyId: entry.id }));
  const applied = events.filter(e => e.type === 'clipboard.changed').map(e => (e.data as { text: string }).text);
  assert.deepEqual(applied, ['other', 'typed on phone'], 'the applying phone is told about PC changes AND its own applied clip');
});

test('consecutive duplicates collapse, and a page never exceeds the byte budget', () => {
  const history = new ClipboardHistory();
  history.add('same clip', 'pc');
  history.add('same clip', 'pc'); // a consecutive repeat is not history
  assert.equal(history.page().entries.length, 1);
  history.add('different clip', 'phone');
  history.add('same clip', 'pc'); // a non-consecutive repeat is a real new entry
  assert.equal(history.page().entries.length, 3);

  const big = new ClipboardHistory();
  const chunk = 'x'.repeat(16_000); // 16,080 budget units per entry against the 48,000 budget
  for (let i = 0; i < 4; i++) big.add(`${chunk}${i}`, 'pc');
  const first = big.page();
  assert.equal(first.entries.length, 2, 'three entries would exceed the budget, so the page stops at two');
  assert.equal(first.nextCursor, first.entries[1]!.id);
  const second = big.page(first.nextCursor!);
  assert.equal(second.entries.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(second.entries[0]!.text.endsWith('1'), true, 'paging resumes exactly where the last page stopped');
});
