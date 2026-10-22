import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalApi } from '../src/terminal.js';
import { NotSent, type OrbitSession } from '../src/session.js';

const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
function slow() {
  const calls: { type: string; payload: unknown }[] = [];
  const answers: ((value: unknown) => void)[] = [];
  const session = { command: (type: string, payload: unknown) => { calls.push({ type, payload });
      return type === 'terminal.begin' ? new Promise(resolve => { answers.push(resolve); }) : Promise.resolve({ ended: true }); },
    onStatus: () => {}, onEvent: () => () => {} } as unknown as OrbitSession;
  const reply = (index: number, id: string) => answers[index]!({ sessionId: id, cwd: 'C:\\', idleTimeoutMs: 300000 });
  return { session, calls, reply };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('ending while the computer owner is still deciding releases a session approved afterwards', async () => {
  const { session, calls, reply } = slow();
  const api = new TerminalApi(session);
  const outcome = api.begin().then(() => 'open', (error: unknown) => error);
  await tick();
  await api.end();
  reply(0, A);
  assert.ok(await outcome instanceof NotSent);
  await tick();
  assert.equal(api.activeSessionId, undefined);
  assert.deepEqual(calls.map(c => c.type), ['terminal.begin', 'terminal.end']);
  assert.deepEqual(calls[1]!.payload, { sessionId: A });
});

test('disposing while waiting releases the late session too', async () => {
  const { session, calls, reply } = slow();
  const api = new TerminalApi(session);
  const outcome = api.begin().then(() => 'open', (error: unknown) => error);
  await tick();
  api.dispose();
  reply(0, A);
  assert.ok(await outcome instanceof NotSent);
  await tick();
  assert.deepEqual(calls.map(c => c.type), ['terminal.begin', 'terminal.end']);
});

test('a newer begin replaces an older pending one, which is released when it arrives', async () => {
  const { session, calls, reply } = slow();
  const api = new TerminalApi(session);
  const first = api.begin().then(() => 'open', (error: unknown) => error);
  const second = api.begin();
  await tick();
  reply(0, A);
  assert.ok(await first instanceof NotSent);
  assert.equal(api.activeSessionId, undefined);
  reply(1, B);
  await second;
  assert.equal(api.activeSessionId, B);
  await tick();
  assert.deepEqual(calls.filter(c => c.type === 'terminal.end').map(c => c.payload), [{ sessionId: A }]);
});
