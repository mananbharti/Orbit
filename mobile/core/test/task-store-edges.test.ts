import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApi } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { TaskStore } from '../src/task-store.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

const T1 = '66666666-6666-4666-8666-666666666661';
const T2 = '66666666-6666-4666-8666-666666666662';
const sum = (taskId: string, state: string, createdAt = 1, updatedAt = 1) => ({ taskId, state, createdAt, updatedAt, headline: state });
let n = 0;
const uuid = () => `77777777-7777-4777-8777-${String(++n).padStart(12, '0')}`;
const push = (t: FakeTransport, data: unknown) => t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'agent.task', data } });

async function slowList(listed: unknown[]) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  let answerList: () => void = () => {};
  t.last.onSend = text => {
    const m = parseSent(text);
    if (m.type === 'agent.list') answerList = () => t.last.reply(m.requestId, { tasks: listed });
    else if (m.type === 'agent.events') t.last.reply(m.requestId, { events: [], hasMore: false });
  };
  const store = new TaskStore(s, new AgentApi(s, uuid));
  await sleep(20);
  return { t, s, store, answerList: () => answerList() };
}

test('a list reply that was read before a newer push never rolls the task back', async () => {
  const { t, s, store, answerList } = await slowList([sum(T1, 'running', 1, 1)]);
  push(t, sum(T1, 'completed', 1, 5));
  await sleep(10);
  assert.equal(store.getState().tasks[0]!.state, 'completed');
  answerList();
  await sleep(20);
  assert.equal(store.getState().tasks[0]!.state, 'completed');
  store.dispose(); s.stop();
});

test('a task pushed while the list was loading is kept even though the older list lacks it', async () => {
  const { t, s, store, answerList } = await slowList([sum(T1, 'completed', 1, 1)]);
  push(t, sum(T2, 'running', 2, 2));
  await sleep(10);
  answerList();
  await sleep(20);
  assert.deepEqual(store.getState().tasks.map(task => task.taskId).sort(), [T1, T2].sort());
  store.dispose(); s.stop();
});

test('a newer list still replaces older local state, and tasks the desktop dropped disappear', async () => {
  const { t, s, store, answerList } = await slowList([sum(T1, 'completed', 1, 9)]);
  push(t, sum(T1, 'running', 1, 3));
  await sleep(10);
  answerList();
  await sleep(20);
  assert.equal(store.getState().tasks[0]!.state, 'completed');
  store.dispose(); s.stop();
  const second = await slowList([sum(T1, 'running', 1, 1)]);
  answerList();
  await sleep(1);
  second.answerList();
  await sleep(20);
  assert.deepEqual(second.store.getState().tasks.map(task => task.taskId), [T1]);
  second.store.dispose(); second.s.stop();
});

test('only changes made during a refresh are protected: a task pushed earlier is dropped when a later list lacks it', async () => {
  const { t, s, store, answerList } = await slowList([sum(T1, 'completed', 1, 1)]);
  answerList();
  await sleep(10);
  push(t, sum(T2, 'running', 2, 2));
  await sleep(10);
  assert.equal(store.getState().tasks.length, 2);
  const refreshed = store.refresh();
  await sleep(5);
  answerList();
  await refreshed;
  assert.deepEqual(store.getState().tasks.map(task => task.taskId), [T1]);
  store.dispose(); s.stop();
});
