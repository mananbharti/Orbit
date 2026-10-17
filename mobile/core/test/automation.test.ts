import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationApi } from '../src/automation.js';
import type { OrbitSession } from '../src/session.js';

function fake(result: unknown): { session: OrbitSession; calls: { type: string; payload: unknown }[] } {
  const calls: { type: string; payload: unknown }[] = [];
  const session = { command: async (type: string, payload: unknown) => { calls.push({ type, payload }); return result; },
    onStatus: () => { /* noop */ } } as unknown as OrbitSession;
  return { session, calls };
}
const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const entry = { id: A, time: '09:30', days: [1, 2, 3], enabled: true, action: { type: 'power', action: 'sleep' } };

test('automation api sends the wire commands and caches the fresh list', async () => {
  const { session, calls } = fake({ automations: [entry] });
  const api = new AutomationApi(session);
  assert.equal((await api.refresh()).length, 1);
  assert.equal(calls[0]!.type, 'automation.list');
  await api.save({ time: '22:00', days: [], action: { type: 'power', action: 'lock' } });
  assert.equal(calls[1]!.type, 'automation.save');
  assert.deepEqual(calls[1]!.payload, { time: '22:00', days: [], action: { type: 'power', action: 'lock' } });
  await api.setEnabled(A, false);
  assert.equal(calls[2]!.type, 'automation.enable');
  await api.remove(A);
  assert.equal(calls[3]!.type, 'automation.delete');
  assert.deepEqual(calls[3]!.payload, { id: A });
  assert.deepEqual(api.getAutomations(), [entry]);
});

test('automation api rejects a malformed reply', async () => {
  const api = new AutomationApi(fake({ nonsense: true }).session);
  await assert.rejects(api.refresh(), /unexpected reply/);
});
