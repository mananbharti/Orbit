import assert from 'node:assert/strict';
import test from 'node:test';
import { InputApi } from '../src/input.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

let n = 0;
const uuid = () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, '0')}`;
const LEASE = { controlSessionId: '77777777-7777-4777-8777-777777777777', nextSequence: 1, heartbeatTimeoutMs: 5000 };

async function pending() {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: string[] = [];
  const approvals: (() => void)[] = [];
  t.last.onSend = text => {
    const m = parseSent(text); calls.push(m.type);
    if (m.type === 'input.begin') approvals.push(() => t.last.reply(m.requestId, LEASE));
    else t.last.reply(m.requestId, {});
  };
  return { s, calls, approve: (index = 0) => approvals[index]!(), api: new InputApi(s) };
}

test('leaving the screen while waiting for the computer owner never leaves a live control session', async () => {
  const { s, calls, approve, api } = await pending();
  const outcome = api.begin().then(() => 'active', (error: unknown) => error);
  await sleep(5);
  assert.equal(api.getState().status, 'waiting');
  await api.end();
  assert.equal(api.getState().status, 'idle');
  approve();
  assert.ok(await outcome instanceof NotSent);
  await sleep(10);
  assert.equal(api.getState().status, 'idle');
  assert.deepEqual(calls, ['input.begin', 'input.end']);
  assert.throws(() => api.push({ t: 'click', button: 'left' } as never), NotSent);
  api.dispose(); s.stop();
});

test('disposing while waiting releases a control session that is approved afterwards', async () => {
  const { s, calls, approve, api } = await pending();
  const outcome = api.begin().then(() => 'active', (error: unknown) => error);
  await sleep(5);
  api.dispose();
  approve();
  assert.ok(await outcome instanceof NotSent);
  await sleep(10);
  assert.deepEqual(calls, ['input.begin', 'input.end']);
  s.stop();
});

test('beginning again after cancelling a wait works and is not disturbed by the old reply', async () => {
  const { s, approve, api } = await pending();
  const first = api.begin().then(() => 'active', (error: unknown) => error);
  await sleep(5);
  await api.end();
  const second = api.begin();
  await sleep(5);
  approve(0);
  assert.ok(await first instanceof NotSent);
  assert.deepEqual(api.getState(), { status: 'waiting' });
  approve(1);
  await second;
  assert.equal(api.getState().status, 'active');
  await api.end(); api.dispose(); s.stop();
});
