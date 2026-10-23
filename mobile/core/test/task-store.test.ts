import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApi } from '../src/agent.js';
import { CommandError, OrbitSession } from '../src/session.js';
import { TaskStore } from '../src/task-store.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

const T1 = '44444444-4444-4444-8444-444444444441';
const T2 = '44444444-4444-4444-8444-444444444442';
const sum = (taskId: string, state: string, createdAt = 1, updatedAt = 1) => ({ taskId, state, createdAt, updatedAt, headline: state });
let n = 0;
const uuid = () => `55555555-5555-4555-8555-${String(++n).padStart(12, '0')}`;

async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const wire = (): void => { t.last.onSend = text => { const m = parseSent(text); const r = handler(m.type, m.payload);
    if (r instanceof CommandError) return t.last.fail(m.requestId, r.code); t.last.reply(m.requestId, r); }; };
  wire();
  const store = new TaskStore(s, new AgentApi(s, uuid));
  return { t, s, store, wire };
}
const push = (t: FakeTransport, data: unknown) => t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'agent.task', data } });

test('loads the list on connect, newest first, and flags tasks that need the user', async () => {
  const { s, store } = await setup(type => type === 'agent.list'
    ? { tasks: [sum(T1, 'completed', 1), sum(T2, 'awaiting-approval', 2)] } : { events: [], hasMore: false });
  await sleep(20);
  const state = store.getState();
  assert.deepEqual(state.tasks.map(t => t.taskId), [T2, T1]);
  assert.deepEqual(state.needsAttention.map(t => t.taskId), [T2]);
  assert.equal(state.connection, 'connected');
  store.dispose(); s.stop();
});
test('pushed updates replace the task and fetch only new events', async () => {
  const afters: number[] = [];
  const { t, s, store } = await setup((type, p) => {
    if (type === 'agent.list') return { tasks: [sum(T1, 'running', 1, 1)] };
    afters.push(p.afterSeq);
    return { events: afters.length === 1 ? [{ seq: 1, at: 1, kind: 'step', text: 'a' }] : [{ seq: 2, at: 2, kind: 'output', text: 'b' }], hasMore: false };
  });
  await sleep(20);
  push(t, sum(T1, 'completed', 1, 5));
  await sleep(20);
  assert.equal(store.getState().tasks[0]!.state, 'completed');
  assert.deepEqual(store.getState().events[T1]!.map(e => e.seq), [1, 2]);
  assert.deepEqual(afters, [0, 1]);
  store.dispose(); s.stop();
});
test('a stale push never overwrites newer state', async () => {
  const { t, s, store } = await setup(type => type === 'agent.list' ? { tasks: [sum(T1, 'completed', 1, 9)] } : { events: [], hasMore: false });
  await sleep(20);
  push(t, sum(T1, 'running', 1, 3));
  await sleep(10);
  assert.equal(store.getState().tasks[0]!.state, 'completed');
  store.dispose(); s.stop();
});
test('malformed pushes and other event types are ignored', async () => {
  const { t, s, store } = await setup(type => type === 'agent.list' ? { tasks: [] } : { events: [], hasMore: false });
  await sleep(20);
  push(t, { junk: true });
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'clipboard.changed', data: sum(T1, 'running') } });
  await sleep(10);
  assert.equal(store.getState().tasks.length, 0);
  store.dispose(); s.stop();
});
test('submit adds the task immediately; approve refreshes it', async () => {
  let state = 'queued';
  const { s, store } = await setup(type => {
    if (type === 'agent.list') return { tasks: [] };
    if (type === 'agent.submit') return sum(T1, 'awaiting-approval', 1, 1);
    if (type === 'agent.approve') { state = 'running'; return { status: 'approved' }; }
    if (type === 'agent.get') return sum(T1, state, 1, 2);
    return { events: [], hasMore: false };
  });
  await sleep(20);
  await store.submit('do it');
  assert.deepEqual(store.getState().needsAttention.map(t => t.taskId), [T1]);
  await store.approve(T1, true);
  assert.equal(store.getState().tasks[0]!.state, 'running');
  assert.equal(store.getState().needsAttention.length, 0);
  store.dispose(); s.stop();
});
test('errors become a message in state; the store keeps working', async () => {
  const { s, store } = await setup(() => ({ nonsense: true }));
  await sleep(20);
  assert.match(store.getState().lastError ?? '', /unexpected reply/);
  store.dispose(); s.stop();
});
test('subscribers get a new snapshot object on every change, and can unsubscribe', async () => {
  const { t, s, store } = await setup(type => type === 'agent.list' ? { tasks: [] } : { events: [], hasMore: false });
  await sleep(20);
  let calls = 0; const off = store.subscribe(() => calls++);
  const before = store.getState();
  push(t, sum(T1, 'running', 1, 1));
  await sleep(20);
  assert.ok(calls >= 1);
  assert.notEqual(store.getState(), before);
  off(); const seen = calls;
  push(t, sum(T1, 'completed', 1, 2));
  await sleep(20);
  assert.equal(calls, seen);
  store.dispose(); s.stop();
});
test('a slow events reply that arrives after a newer one never rolls the event list back', async () => {
  const log = [{ seq: 1, at: 1, kind: 'step', text: 'a' }];
  const handler = (type: string, p: any): unknown => type === 'agent.list' ? { tasks: [sum(T1, 'running', 1, 1)] }
    : { events: log.filter(e => e.seq > p.afterSeq), hasMore: false };
  const { t, s, store } = await setup(handler);
  await sleep(20);
  let calls = 0;
  // The first fetch is answered late, with what the log held when it was asked.
  t.last.onSend = text => {
    const m = parseSent(text); const body = handler(m.type, m.payload); const late = calls++ === 0;
    setTimeout(() => t.last.reply(m.requestId, body), late ? 40 : 5);
  };
  log.push({ seq: 2, at: 2, kind: 'output', text: 'b' });
  push(t, sum(T1, 'running', 1, 2));
  await sleep(5);
  log.push({ seq: 3, at: 3, kind: 'output', text: 'c' });
  push(t, sum(T1, 'completed', 1, 3));
  await sleep(120);
  assert.deepEqual(store.getState().events[T1]!.map(e => e.seq), [1, 2, 3]);
  store.dispose(); s.stop();
});
test('a desktop without an agent backend reads as a setup state, not an error', async () => {
  const { s, store } = await setup(() => new CommandError('UNKNOWN_COMMAND'));
  await sleep(20);
  const state = store.getState();
  assert.equal(state.agentAvailable, false);
  assert.equal(state.lastError, undefined); // not an error banner: the computer needs setup
  store.dispose(); s.stop();
});
test('a later successful list clears the unavailable flag', async () => {
  let down = true;
  const { s, store } = await setup(type => {
    if (down) return new CommandError('UNKNOWN_COMMAND');
    return type === 'agent.list' ? { tasks: [] } : { events: [], hasMore: false };
  });
  await sleep(20);
  assert.equal(store.getState().agentAvailable, false);
  down = false;
  await store.refresh();
  assert.equal(store.getState().agentAvailable, true);
  store.dispose(); s.stop();
});
test('a real failure still surfaces as an error and keeps the flag untouched', async () => {
  const { s, store } = await setup(() => new CommandError('BUSY'));
  await sleep(20);
  const state = store.getState();
  assert.equal(state.agentAvailable, undefined);
  assert.equal(state.lastError, 'BUSY');
  store.dispose(); s.stop();
});
