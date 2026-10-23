import assert from 'node:assert/strict';
import test from 'node:test';
import { OrbitSession } from '../src/session.js';
import { DevicesApi } from '../src/devices.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
const A = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-bccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-bddd-dddddddddddd';

test('refresh, setScopes and revoke get the long timeout and remember the current device id', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, commandTimeoutMs: 20, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: string[] = [];
  t.last.onSend = text => {
    const m = parseSent(text); calls.push(m.type);
    const current = m.type === 'pair.devices' ? B : m.type === 'pair.scopes.set' ? C : D;
    setTimeout(() => t.last.reply(m.requestId, { current, devices: [{ deviceId: A, scopes: 'all' }] }), 60);
  };
  const api = new DevicesApi(s);
  await api.refresh();
  assert.equal(api.currentId(), B);
  await api.setScopes(A, ['files']);
  assert.equal(api.currentId(), C);
  await api.revoke(A);
  assert.equal(api.currentId(), D);
  assert.deepEqual(calls, ['pair.devices', 'pair.scopes.set', 'pair.revoke']);
  s.stop();
});
test('a failed command leaves the current device id and cached list untouched', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  let fail = false;
  t.last.onSend = text => {
    const m = parseSent(text);
    if (fail) t.last.fail(m.requestId, 'BUSY');
    else t.last.reply(m.requestId, { current: B, devices: [{ deviceId: A, scopes: 'all' }] });
  };
  const api = new DevicesApi(s);
  await api.refresh();
  fail = true;
  await assert.rejects(api.refresh());
  assert.equal(api.currentId(), B);
  assert.equal(api.getDevices().length, 1);
  s.stop();
});
