import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { MemoryApi } from '../src/memory.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const ID = '55555555-5555-4555-8555-555555555555';
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new MemoryApi(s) };
}

test('remember sends the input verbatim and returns the new id', async () => {
  const { s, api, calls } = await setup(() => ({ id: ID }));
  const id = await api.remember({ name: 'Asha', kind: 'person', fact: 'likes filter coffee', relatedTo: 'Rahul', relation: 'sister' });
  assert.equal(id, ID);
  assert.deepEqual(calls[0], { type: 'memory.remember',
    payload: { name: 'Asha', kind: 'person', fact: 'likes filter coffee', relatedTo: 'Rahul', relation: 'sister' } });
  s.stop();
});

test('recall passes query and optional limit and returns validated hits', async () => {
  const hit = { id: ID, name: 'Asha', kind: 'person', facts: ['likes filter coffee'], via: 'Rahul' };
  const { s, api, calls } = await setup(() => ({ results: [hit] }));
  assert.deepEqual(await api.recall('coffee'), [hit]);
  assert.deepEqual(calls[0], { type: 'memory.recall', payload: { query: 'coffee' } });
  await api.recall('coffee', 5);
  assert.deepEqual(calls[1], { type: 'memory.recall', payload: { query: 'coffee', limit: 5 } });
  s.stop();
});

test('forget returns whether anything was removed', async () => {
  const { s, api, calls } = await setup(() => ({ removed: true }));
  assert.equal(await api.forget(ID), true);
  assert.deepEqual(calls[0], { type: 'memory.forget', payload: { id: ID } });
  s.stop();
});

test('malformed replies are rejected instead of trusted', async () => {
  const badRemember = await setup(() => ({ id: 'not-a-uuid' }));
  await assert.rejects(badRemember.api.remember({ name: 'x' }), InvalidDesktopReply);
  badRemember.s.stop();
  const badRecall = await setup(() => ({ results: [{ id: ID, name: 42 }] }));
  await assert.rejects(badRecall.api.recall('x'), InvalidDesktopReply);
  badRecall.s.stop();
  const badForget = await setup(() => ({ removed: 'yes' }));
  await assert.rejects(badForget.api.forget(ID), InvalidDesktopReply);
  badForget.s.stop();
});
