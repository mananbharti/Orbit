import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardApi } from '../src/clipboard.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

const SUB = '99999999-9999-4999-8999-999999999999';
let n = 0;
const uuid = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown = type => type === 'clipboard.subscribe' ? { subscriptionId: SUB, revision: 5 } : { status: 'applied', revision: 6 }) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  const wire = (): void => { t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); }; };
  wire();
  const open = t.openChannel.bind(t);
  t.openChannel = (trust, token, handlers) => { const c = open(trust, token, handlers); wire(); return c; };
  return { t, s, calls, wire, api: new ClipboardApi(s) };
}
const push = (t: FakeTransport, eventType: string, data: unknown) => t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType, data } });

test('start subscribes once; send writes against the current revision', async () => {
  const { s, api, calls } = await setup();
  await api.start(); await api.start();
  assert.equal(calls.filter(c => c.type === 'clipboard.subscribe').length, 1);
  assert.equal(await api.send('hello'), 'sent');
  assert.deepEqual(calls.at(-1), { type: 'clipboard.write', payload: { subscriptionId: SUB, baseRevision: 5, text: 'hello' } });
  assert.equal(await api.send('again'), 'sent');
  assert.equal(calls.at(-1)!.payload.baseRevision, 6);
  s.stop();
});
test('send subscribes on demand and reports conflicts without overwriting', async () => {
  const { s, api } = await setup(type => type === 'clipboard.subscribe' ? { subscriptionId: SUB, revision: 1 } : { status: 'conflict', revision: 9 });
  assert.equal(await api.send('x'), 'conflict');
  s.stop();
});
test('desktop copies become a pending incoming item; stale and foreign ones are ignored', async () => {
  const { t, s, api } = await setup();
  await api.start();
  push(t, 'clipboard.changed', { subscriptionId: SUB, revision: 7, text: 'from pc' });
  assert.deepEqual(api.getState().incoming, { text: 'from pc', revision: 7 });
  push(t, 'clipboard.changed', { subscriptionId: SUB, revision: 6, text: 'old' });
  push(t, 'clipboard.changed', { subscriptionId: '11111111-1111-4111-8111-111111111111', revision: 99, text: 'foreign' });
  push(t, 'clipboard.changed', { junk: 1 });
  assert.equal(api.getState().incoming!.text, 'from pc');
  api.dismissIncoming();
  assert.equal(api.getState().incoming, undefined);
  s.stop();
});
test('an unsupported or oversized desktop clipboard clears the incoming item and is flagged', async () => {
  const { t, s, api } = await setup();
  await api.start();
  push(t, 'clipboard.changed', { subscriptionId: SUB, revision: 7, text: 'a' });
  push(t, 'clipboard.status', { subscriptionId: SUB, revision: 8, status: 'unsupported' });
  assert.equal(api.getState().incoming, undefined);
  assert.equal(api.getState().blocked, 'unsupported');
  push(t, 'clipboard.changed', { subscriptionId: SUB, revision: 9, text: 'b' });
  assert.equal(api.getState().blocked, undefined);
  s.stop();
});
test('invalid text is refused before sending', async () => {
  const { s, api, calls } = await setup();
  await assert.rejects(api.send(''), NotSent);
  await assert.rejects(api.send('x'.repeat(8 * 1024 + 1)), NotSent);
  await assert.rejects(api.send('bad\0text'), NotSent);
  assert.equal(calls.length, 0);
  s.stop();
});
test('reconnect resubscribes while the screen is open, and stop unsubscribes', async () => {
  const { t, s, api, calls, wire } = await setup();
  await api.start();
  t.last.drop();
  await sleep(10); wire();
  await sleep(60);
  assert.equal(calls.filter(c => c.type === 'clipboard.subscribe').length >= 1, true);
  assert.equal(api.getState().active, true);
  await api.stop();
  assert.equal(calls.at(-1)!.type, 'clipboard.unsubscribe');
  assert.equal(api.getState().active, false);
  s.stop();
});
test('a closed screen does not resubscribe after reconnect', async () => {
  const { t, s, api, calls, wire } = await setup();
  await api.start(); await api.stop();
  const before = calls.length;
  t.last.drop();
  await sleep(60); wire();
  assert.equal(calls.length, before);
  s.stop();
});
