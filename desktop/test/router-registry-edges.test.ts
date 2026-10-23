/** Verifies router bookkeeping and registry guards the main suites leave open: the 128-session cap, expired-entry eviction, command-name limits, session.* reservation, duplicate refusal and unregister safety; depends on stub auth only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { CommandRouter } from '../src/command-router/command-router.js';
import type { Session, SessionAuth } from '../src/security-pairing/session-auth.js';

function session(id: string, expiresAt = Date.now() + 60_000): Session {
  return { deviceId: `device-${id}`, sessionId: id, expiresAt };
}
function routerWith(auth: SessionAuth): { router: CommandRouter; registry: CommandRegistry } {
  const registry = new CommandRegistry();
  registry.register('test.echo', { validate: () => true, execute: async payload => payload });
  const biometric = { verify: async () => true };
  return { registry, router: new CommandRouter(registry, auth, new ActivityLog(), biometric) };
}
const call = (router: CommandRouter, token: string, requestId = randomUUID()) =>
  router.dispatch({ version: 1, type: 'test.echo', requestId, payload: {} }, token);
const busy = (response: { payload: { ok: boolean; error?: { code: string } } }) =>
  !response.payload.ok && response.payload.error?.code === 'BUSY';

test('at most 128 sessions are tracked at once, and expired entries are evicted before refusing', async () => {
  const sessions = new Map<string, Session>();
  const auth = { authenticate: (token: string) => sessions.get(token) } as SessionAuth;
  const { router } = routerWith(auth);
  for (let i = 0; i < 128; i++) sessions.set(`active-${i}`, session(`active-${i}`));
  for (let i = 0; i < 128; i++) assert.ok((await call(router, `active-${i}`)).payload.ok, `session ${i} dispatches`);
  sessions.set('one-too-many', session('one-too-many'));
  assert.ok(busy(await call(router, 'one-too-many')), 'the 129th live session is refused');

  const evicting = new Map<string, Session>();
  const evictAuth = { authenticate: (token: string) => evicting.get(token) } as SessionAuth;
  const { router: second } = routerWith(evictAuth);
  for (let i = 0; i < 128; i++) evicting.set(`stale-${i}`, session(`stale-${i}`, Date.now() - 1));
  for (let i = 0; i < 128; i++) await call(second, `stale-${i}`);
  evicting.set('fresh', session('fresh'));
  assert.ok((await call(second, 'fresh')).payload.ok, 'expired entries never crowd out a live session');
});

test('the registry enforces name limits, the session.* reservation, duplicates and safe unregister', () => {
  const registry = new CommandRegistry();
  const handler = { validate: () => true, execute: async () => null };
  registry.register(`${'a'.repeat(61)}.bb`, handler); // 64 characters exactly
  assert.throws(() => registry.register(`${'a'.repeat(62)}.bb`, handler), /Invalid or duplicate/, '65 characters is too long');
  assert.throws(() => registry.register('session.refresh', handler), /Invalid or duplicate/, 'session.* is reserved');
  const first = { validate: () => true, execute: async () => null };
  const second = { validate: () => true, execute: async () => null };
  const removeFirst = registry.register('test.guarded', first);
  assert.throws(() => registry.register('test.guarded', second), /Invalid or duplicate/, 'duplicates are refused');
  removeFirst();
  registry.register('test.guarded', second);
  removeFirst(); // a stale unregister must not remove the replacement
  assert.equal(registry.get('test.guarded'), second, 'the replacement handler survives');
});
