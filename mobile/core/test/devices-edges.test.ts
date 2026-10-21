import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicesApi } from '../src/devices.js';
import type { OrbitSession } from '../src/session.js';

const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
function fake(replies: unknown[]) {
  const listeners: ((s: string) => void)[] = [];
  const calls: { type: string; payload: unknown }[] = [];
  const session = { command: async (type: string, payload: unknown) => { calls.push({ type, payload }); const r = replies.shift(); if (r instanceof Error) throw r; return r; },
    onStatus: (l: (s: string) => void) => { listeners.push(l); return () => undefined; } } as unknown as OrbitSession;
  return { session, calls, status: (s: string) => listeners.forEach(l => l(s)) };
}
const list = (...ids: string[]) => ({ current: A, devices: ids.map(deviceId => ({ deviceId, scopes: 'all' as const })) });

test('a bad reply or a failed command leaves the last good list in place', async () => {
  const f = fake([list(A, B), { junk: 1 }, new Error('offline')]);
  const api = new DevicesApi(f.session);
  await api.refresh();
  await assert.rejects(api.refresh());
  await assert.rejects(api.revoke(B));
  assert.deepEqual(api.getDevices().map(d => d.deviceId), [A, B]);
  assert.equal(api.currentId(), A);
});

test('the list the caller gets is a copy, so editing it cannot change the cache', async () => {
  const api = new DevicesApi(fake([list(A, B)]).session);
  const got = await api.refresh();
  got.pop();
  api.getDevices().length = 0;
  assert.equal(api.getDevices().length, 2);
});

test('any connection status change drops the cached list and current id', async () => {
  const f = fake([list(A, B)]);
  const api = new DevicesApi(f.session);
  await api.refresh();
  f.status('reconnecting');
  assert.deepEqual(api.getDevices(), []);
  assert.equal(api.currentId(), '');
});

test('revoke sends the device id and returns the list without it', async () => {
  const f = fake([list(A)]);
  const api = new DevicesApi(f.session);
  const after = await api.revoke(B);
  assert.deepEqual(f.calls[0], { type: 'pair.revoke', payload: { deviceId: B } });
  assert.deepEqual(after.map(d => d.deviceId), [A]);
});
