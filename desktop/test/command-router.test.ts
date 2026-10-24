/** Tests dispatch and protocol boundaries; depends on the built-in runner and test core; performs no OS actions. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import type { ActivityEvent } from '../src/activity-log/activity-event.js';
import { parseMessage } from '../src/protocol/validation.js';
import { core } from './helpers.js';

const command = (type = 'test.echo', payload = {}) => ({ version: 1 as const, type, requestId: randomUUID(), payload });

test('dispatch requires a live session and validates handler payloads', async () => {
  const fixture = core();
  let calls = 0;
  fixture.registry.register('test.echo', { validate: payload => payload === null,
    execute: async () => { calls++; return 'ok'; } });
  const token = fixture.auth.issue(fixture.credential)!.sessionToken;
  assert.deepEqual((await fixture.router.dispatch(command(), '')).payload,
    { ok: false, error: { code: 'UNAUTHENTICATED' } });
  assert.deepEqual((await fixture.router.dispatch(command(), token)).payload,
    { ok: false, error: { code: 'INVALID_PAYLOAD' } });
  assert.deepEqual((await fixture.router.dispatch({ ...command(), payload: null }, token)).payload,
    { ok: true, result: 'ok' });
  assert.equal(calls, 1);
  fixture.revoke();
  assert.equal((await fixture.router.dispatch(command(), token)).payload.ok, false);
  assert.equal(calls, 1);
});

test('unknown commands and thrown handler errors remain safe wire errors', async () => {
  const fixture = core();
  const token = fixture.auth.issue(fixture.credential)!.sessionToken;
  fixture.registry.register('test.throw', { validate: () => true,
    execute: async () => { throw new Error('SECRET clipboard contents'); } });
  assert.deepEqual((await fixture.router.dispatch(command('test.unknown'), token)).payload,
    { ok: false, error: { code: 'UNKNOWN_COMMAND' } });
  assert.deepEqual((await fixture.router.dispatch(command('test.throw'), token)).payload,
    { ok: false, error: { code: 'COMMAND_FAILED' } });
  assert.doesNotMatch(JSON.stringify(fixture.log.snapshot()), /SECRET|clipboard contents/);
  assert.equal(fixture.log.snapshot().at(-1)?.outcome, 'failed');
});

test('power commands (the real wire name system.power) require verified biometrics, never a payload boolean (input is confirmed once per control session)', async () => {
  const fixture = core();
  let calls = 0;
  for (const type of ['system.power']) {
    fixture.registry.register(type, { validate: () => true, execute: async () => { calls++; return null; } });
    assert.deepEqual((await fixture.router.dispatch(command(type, { biometricConfirmed: true }),
      fixture.auth.issue(fixture.credential)!.sessionToken)).payload,
    { ok: false, error: { code: 'BIOMETRIC_REQUIRED' } });
  }
  assert.equal(calls, 0);
});

test('biometric hook gets verified identity and rechecks expiry after awaiting confirmation', async () => {
  let now = Date.now();
  let calls = 0;
  let verified = false;
  const fixture = core({ now: () => now, ttlMs: 100,
    biometric: { verify: async (message, context) => {
      assert.equal(message.type, 'system.power');
      assert.equal(context.session.deviceId, fixture.deviceId);
      if (verified) now += 101;
      verified = true;
      return true;
    } } });
  fixture.registry.register('system.power', { validate: () => true, execute: async () => { calls++; return null; } });
  const token = fixture.auth.issue(fixture.credential)!.sessionToken;
  assert.equal((await fixture.router.dispatch(command('system.power'), token)).payload.ok, true);
  assert.deepEqual((await fixture.router.dispatch(command('system.power'), token)).payload,
    { ok: false, error: { code: 'UNAUTHENTICATED' } });
  assert.equal(calls, 1);
});

test('duplicate request IDs cannot repeat execution within a session', async () => {
  const fixture = core();
  let calls = 0;
  fixture.registry.register('test.echo', { validate: () => true, execute: async () => { calls++; return null; } });
  const token = fixture.auth.issue(fixture.credential)!.sessionToken;
  const message = command();
  const [first, second] = await Promise.all([fixture.router.dispatch(message, token), fixture.router.dispatch(message, token)]);
  assert.equal(first.payload.ok, true);
  assert.deepEqual(second.payload, { ok: false, error: { code: 'DUPLICATE_REQUEST' } });
  assert.equal(calls, 1);
});

test('a session cannot accumulate request IDs without bound', async () => {
  const fixture = core();
  let calls = 0;
  fixture.registry.register('test.echo', { validate: () => true, execute: async () => { calls++; return null; } });
  const token = fixture.auth.issue(fixture.credential)!.sessionToken;
  for (let batch = 0; batch < 16; batch++) {
    const results = await Promise.all(Array.from({ length: 256 }, () => fixture.router.dispatch(command(), token)));
    for (const result of results) assert.equal(result.payload.ok, true);
  }
  assert.equal(calls, 4_096);
  const over = await fixture.router.dispatch(command(), token);
  assert.deepEqual(over.payload, { ok: false, error: { code: 'BUSY' } });
  assert.equal(calls, 4_096, 'the command past the cap never executes');
});

test('malformed, unversioned, extra-field and unsupported envelopes are rejected', () => {
  for (const value of ['{', 'null', '[]', '{}', JSON.stringify({ ...command(), version: 2 }),
    JSON.stringify({ ...command(), sessionToken: 'secret' }), JSON.stringify({ ...command(), requestId: 'free text' })]) {
    assert.throws(() => parseMessage(value));
  }
  const message = command();
  assert.deepEqual(parseMessage(JSON.stringify(message)), message);
});

test('Activity Log is bounded, metadata-only, and snapshots cannot mutate it', () => {
  const log = new ActivityLog(2);
  const event = { severity: 'info', eventType: 'connection.opened', outcome: 'success',
    payload: 'clipboard secret', sessionToken: 'secret' };
  for (let i = 0; i < 3; i++) log.record(event as Omit<ActivityEvent, 'timestamp'>);
  const snapshot = log.snapshot();
  assert.equal(snapshot.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|payload|sessionToken/);
  snapshot[0]!.outcome = 'failed';
  assert.equal(log.snapshot()[0]!.outcome, 'success');
});
