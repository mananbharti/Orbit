import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardApi } from '../src/clipboard.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const SUB = '99999999-9999-4999-8999-999999999999';
let n = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown, replyDelayMs = 0) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => {
    const m = parseSent(text); calls.push({ type: m.type, payload: m.payload });
    const body = handler(m.type, m.payload);
    if (replyDelayMs) setTimeout(() => t.last.reply(m.requestId, body), replyDelayMs); else t.last.reply(m.requestId, body);
  };
  return { t, s, calls, api: new ClipboardApi(s) };
}
const push = (t: FakeTransport, eventType: string, data: unknown) => t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType, data } });
const ok = (type: string) => type === 'clipboard.subscribe' ? { subscriptionId: SUB, revision: 5 } : { status: 'applied', revision: 6 };

test('the size limit counts UTF-8 bytes: a clip of exactly 8 KB of multibyte text sends, one byte more is refused', async () => {
  const { s, api, calls } = await setup(ok);
  assert.equal(await api.send('é'.repeat(4096)), 'sent');
  assert.equal(await api.send('📱 emoji and 𝌆 astral text are fine'), 'sent');
  await assert.rejects(api.send('é'.repeat(4096) + 'x'), NotSent);
  await assert.rejects(api.send('lone \uD800 surrogate'), NotSent);
  assert.equal(calls.filter(c => c.type === 'clipboard.write').length, 2);
  s.stop();
});

test('history pages pass the cursor and return entries with the next cursor', async () => {
  const entry = { id: SUB, text: 'clip', at: 1, source: 'pc' };
  const { s, api, calls } = await setup(type => type === 'clipboard.subscribe' ? { subscriptionId: SUB, revision: 5 }
    : { entries: [entry], nextCursor: SUB });
  const first = await api.history();
  assert.deepEqual(calls.at(-1), { type: 'clipboard.history', payload: {} });
  assert.equal(first.entries[0]!.text, 'clip');
  const second = await api.history(first.nextCursor!);
  assert.deepEqual(calls.at(-1), { type: 'clipboard.history', payload: { before: SUB } });
  assert.equal(second.entries.length, 1);
  s.stop();
});

test('when the desktop reports its clipboard unavailable the phone drops the subscription and the next send re-subscribes', async () => {
  const { t, s, api, calls } = await setup(ok);
  await api.start();
  push(t, 'clipboard.status', { subscriptionId: SUB, revision: 6, status: 'unavailable' });
  assert.equal(api.getState().active, false);
  assert.equal(await api.send('hello'), 'sent');
  assert.equal(calls.filter(c => c.type === 'clipboard.subscribe').length, 2);
  assert.equal(calls.at(-1)!.payload.baseRevision, 5);
  s.stop();
});

test('two sends started together share one subscription, not two', async () => {
  const { s, api, calls } = await setup(ok, 20);
  const [a, b] = await Promise.all([api.send('one'), api.send('two')]);
  assert.deepEqual([a, b], ['sent', 'sent']);
  assert.equal(calls.filter(c => c.type === 'clipboard.subscribe').length, 1);
  s.stop();
});
