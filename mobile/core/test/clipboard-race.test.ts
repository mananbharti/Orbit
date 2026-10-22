import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardApi } from '../src/clipboard.js';
import { OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

const SUB = '88888888-8888-4888-8888-888888888888';
let n = 0;
const uuid = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, '0')}`;

test('closing the screen while the subscription is being set up leaves no live subscription behind', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: string[] = [];
  let answerSubscribe: () => void = () => {};
  t.last.onSend = text => {
    const m = parseSent(text); calls.push(m.type);
    if (m.type === 'clipboard.subscribe') answerSubscribe = () => t.last.reply(m.requestId, { subscriptionId: SUB, revision: 1 });
    else t.last.reply(m.requestId, {});
  };
  const api = new ClipboardApi(s);
  const starting = api.start();
  await sleep(5);
  await api.stop();
  answerSubscribe();
  await starting.catch(() => {});
  await sleep(10);
  assert.equal(api.getState().active, false);
  assert.deepEqual(calls, ['clipboard.subscribe', 'clipboard.unsubscribe']);
  t.last.deliver({ version: 1, type: 'event', requestId: null,
    payload: { eventType: 'clipboard.changed', data: { subscriptionId: SUB, revision: 9, text: 'late' } } });
  assert.equal(api.getState().incoming, undefined);
  api.dispose(); s.stop();
});
