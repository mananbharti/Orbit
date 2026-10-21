import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationApi } from '../src/automation.js';
import { InvalidDesktopReply } from '../src/agent.js';
import type { OrbitSession } from '../src/session.js';

const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const entry = (id: string) => ({ id, time: '09:30', days: [1], enabled: true, action: { type: 'power', action: 'sleep' } });
function fake(replies: unknown[]) {
  const calls: { type: string; payload: unknown }[] = [];
  const listeners: ((s: string) => void)[] = [];
  const session = { command: async (type: string, payload: unknown) => { calls.push({ type, payload }); const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    onStatus: (l: (s: string) => void) => { listeners.push(l); return () => undefined; } } as unknown as OrbitSession;
  return { session, calls, status: (s: string) => listeners.forEach(l => l(s)) };
}

test('a failed command or a bad reply leaves the cached list intact', async () => {
  const f = fake([{ automations: [entry(A)] }, new Error('offline'), { junk: 1 }]);
  const api = new AutomationApi(f.session);
  await api.refresh();
  await assert.rejects(api.save({ time: '08:00', days: [], action: { type: 'power', action: 'lock' } }));
  await assert.rejects(api.refresh(), InvalidDesktopReply);
  assert.deepEqual(api.getAutomations().map(a => a.id), [A]);
});

test('the list the caller gets is a copy, and a status change clears the cache', async () => {
  const f = fake([{ automations: [entry(A), entry(B)] }]);
  const api = new AutomationApi(f.session);
  const got = await api.refresh();
  got.pop();
  got.length = 0;
  assert.equal(api.getAutomations().length, 2);
  f.status('reconnecting');
  assert.deepEqual(api.getAutomations(), []);
});

test('a desktop reply with more automations than the cap is rejected, not trusted', async () => {
  const many = Array.from({ length: 33 }, (_, i) => entry(`${'c'.repeat(8)}-${'c'.repeat(4)}-4ccc-8ccc-${String(i).padStart(12, '0')}`));
  const api = new AutomationApi(fake([{ automations: many }]).session);
  await assert.rejects(api.refresh(), InvalidDesktopReply);
  assert.deepEqual(api.getAutomations(), []);
});
