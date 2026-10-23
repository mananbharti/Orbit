import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomationApi } from '../src/automation.js';
import { OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const entry = { id: A, time: '09:30', days: [1, 2, 3], enabled: true, action: { type: 'power' as const, action: 'sleep' as const } };

test('every automation command tolerates a slow desktop reply', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, commandTimeoutMs: 20, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: string[] = [];
  t.last.onSend = text => {
    const m = parseSent(text); calls.push(m.type);
    setTimeout(() => t.last.reply(m.requestId, { automations: [entry] }), 60);
  };
  const api = new AutomationApi(s);
  await api.refresh();
  await api.save({ time: '09:30', days: [1], action: { type: 'power', action: 'lock' } });
  await api.setEnabled(A, false);
  await api.remove(A);
  assert.deepEqual(calls, ['automation.list', 'automation.save', 'automation.enable', 'automation.delete']);
  assert.equal(api.getAutomations().length, 1);
  s.stop();
});
