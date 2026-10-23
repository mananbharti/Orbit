import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApi } from '../src/agent.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const TASK = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => { const m = parseSent(text); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, api: new AgentApi(s, uuid) };
}
const ev = (seq: number) => ({ seq, at: seq, kind: 'step', text: `s${seq}` });
const summary = { taskId: TASK, state: 'queued', createdAt: 1, updatedAt: 2, headline: 'Working' };

test('a prompt of exactly 8192 bytes is accepted, counted in UTF-8 bytes not characters', async () => {
  const sent: any[] = [];
  const { s, api } = await setup((_t, p) => { sent.push(p); return summary; });
  await api.submit('x'.repeat(8192));
  await api.submit('é'.repeat(4096));
  assert.equal(sent.length, 2);
  await assert.rejects(api.submit('x'.repeat(8000) + '€'.repeat(96)), NotSent); // 8288 bytes, 8096 characters
  assert.equal(sent.length, 2);
  s.stop();
});
test('events stops after 100 pages even when the desktop keeps saying hasMore', async () => {
  let pages = 0;
  const { s, api } = await setup(() => { pages++; return { events: [ev(pages)], hasMore: true }; });
  const events = await api.events(TASK);
  assert.equal(pages, 100);
  assert.equal(events.length, 100);
  assert.equal(events[99]!.seq, 100);
  s.stop();
});
test('an empty page with hasMore true ends the walk instead of crashing or looping', async () => {
  let calls = 0;
  const { s, api } = await setup(() => { calls++; return calls === 1 ? { events: [ev(1)], hasMore: true } : { events: [], hasMore: true }; });
  assert.deepEqual((await api.events(TASK)).map(e => e.seq), [1]);
  assert.equal(calls, 2);
  s.stop();
});
