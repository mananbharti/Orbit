/** Service settings accept only local addresses and valid values, and refuse legacy overrides. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalAddress, readConfig } from '../src/config.js';

test('private, loopback and link-local addresses are local; public and malformed ones are not', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.137.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '::1', '::ffff:192.168.1.5']) assert.equal(isLocalAddress(a), true, a);
  for (const a of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '0.0.0.0', '2001:db8::1', 'localhost', '']) assert.equal(isLocalAddress(a), false, a);
});

test('defaults bind loopback on 8765 and honor the environment', () => {
  const d = readConfig({ ORBIT_DISPLAY_NAME: 'Omen' });
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.port, 8765);
  assert.equal(d.inbox, undefined);
  const c = readConfig({ ORBIT_HOST: '192.168.137.1', ORBIT_PORT: '9000', ORBIT_DISPLAY_NAME: 'Omen', ORBIT_RECEIVE_DIR: '/tmp/in' });
  assert.equal(c.host, '192.168.137.1');
  assert.equal(c.port, 9000);
  assert.equal(c.inbox, '/tmp/in');
});

test('a public host, bad port, bad display name or legacy override is refused', () => {
  const ok = { ORBIT_DISPLAY_NAME: 'Omen' };
  assert.throws(() => readConfig({ ...ok, ORBIT_HOST: '8.8.8.8' }), /local IP/);
  for (const p of ['0', '65536', '-1', '80.5', 'abc']) assert.throws(() => readConfig({ ...ok, ORBIT_PORT: p }), /ORBIT_PORT/, p);
  assert.throws(() => readConfig({ ORBIT_DISPLAY_NAME: '' }), /display name/);
  assert.throws(() => readConfig({ ORBIT_DISPLAY_NAME: 'x'.repeat(65) }), /display name/);
  assert.throws(() => readConfig({ ORBIT_DISPLAY_NAME: 'bad\nname' }), /display name/);
  for (const k of ['ORBIT_TLS_CERT', 'ORBIT_TLS_KEY', 'ORBIT_CREDENTIAL_STORE']) assert.throws(() => readConfig({ ...ok, [k]: 'x' }), /Legacy/, k);
});
