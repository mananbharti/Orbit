import test from 'node:test';
import assert from 'node:assert/strict';
import { DevicesApi } from '../src/devices.js';
import type { OrbitSession } from '../src/session.js';

function fake(result: unknown): { session: OrbitSession; calls: { type: string; payload: unknown }[] } {
  const calls: { type: string; payload: unknown }[] = [];
  const session = { command: async (type: string, payload: unknown) => { calls.push({ type, payload }); return result; },
    onStatus: () => { /* noop */ } } as unknown as OrbitSession;
  return { session, calls };
}
const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

test('devices refresh returns the list and remembers the current device', async () => {
  const { session, calls } = fake({ current: A, devices: [{ deviceId: A, scopes: 'all' }, { deviceId: B, scopes: ['clipboard'] }] });
  const api = new DevicesApi(session);
  const devices = await api.refresh();
  assert.equal(calls[0]!.type, 'pair.devices');
  assert.equal(devices.length, 2);
  assert.equal(api.currentId(), A);
  assert.equal(api.getDevices()[1]!.deviceId, B);
});

test('devices setScopes sends the payload and caches the fresh list', async () => {
  const { session, calls } = fake({ current: A, devices: [{ deviceId: A, scopes: 'all' }, { deviceId: B, scopes: ['launcher', 'input'] }] });
  const api = new DevicesApi(session);
  await api.setScopes(B, ['launcher', 'input']);
  assert.equal(calls[0]!.type, 'pair.scopes.set');
  assert.deepEqual(calls[0]!.payload, { deviceId: B, scopes: ['launcher', 'input'] });
  assert.deepEqual(api.getDevices()[1]!.scopes, ['launcher', 'input']);
});

test('devices setScopes all restores full access and a bad reply throws', async () => {
  const { session, calls } = fake({ current: A, devices: [{ deviceId: B, scopes: 'all' }] });
  const api = new DevicesApi(session);
  await api.setScopes(B, 'all');
  assert.deepEqual(calls[0]!.payload, { deviceId: B, scopes: 'all' });
  const bad = new DevicesApi(fake({ nonsense: true }).session);
  await assert.rejects(bad.refresh(), /unexpected reply/);
});
