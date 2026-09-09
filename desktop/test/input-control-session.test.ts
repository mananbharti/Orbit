/** Exercises control ownership and cleanup with synthetic adapters; depends on Node's test runner; never sends OS input or grants production biometrics. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import type { CommandContext } from '../src/command-router/command-context.js';
import { InputControlSession, INPUT_HEARTBEAT_TIMEOUT_MS, INPUT_CLEANUP_TIMEOUT_MS } from '../src/input-simulation/control-session.js';
import type { InputSessionAdapter } from '../src/os-integration/input-session.js';
import type { BiometricConfirmation } from '../src/security-pairing/biometric-confirmation.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class FakeAdapter implements InputSessionAdapter {
  calls: string[] = [];
  held = false;
  async open(_signal: AbortSignal): Promise<void> { this.calls.push('open'); }
  async releaseAll(): Promise<void> { this.calls.push('release'); this.held = false; }
  async dispose(): Promise<void> { this.calls.push('dispose'); }
}
function peer(): { context: CommandContext; disconnect: () => void; revoke: () => void } {
  const closed = new AbortController();
  let active = true;
  return { context: { requestId: randomUUID(),
    session: { deviceId: randomUUID(), sessionId: randomUUID(), expiresAt: Date.now() + 60_000 },
    connection: { id: randomUUID(), closed: closed.signal, isAuthorized: () => active, publish: () => {} } },
  disconnect: () => closed.abort(), revoke: () => { active = false; } };
}
function fixture(biometric: BiometricConfirmation = { verify: async () => true }) {
  const log = new ActivityLog();
  const adapters: FakeAdapter[] = [];
  const guard = new InputControlSession(() => { const adapter = new FakeAdapter(); adapters.push(adapter); return adapter; }, log, biometric);
  return { guard, log, adapters, ...peer() };
}
const code = (name: string) => ({ code: name });
async function waitFor(predicate: () => boolean, limit = 1_000): Promise<void> {
  const deadline = Date.now() + limit;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), 'Expected lifecycle transition before deadline');
}

test('default biometric hook denies before adapter creation and requires a live transport context', async () => {
  let created = 0;
  const guard = new InputControlSession(() => { created++; return new FakeAdapter(); }, new ActivityLog());
  const client = peer();
  await assert.rejects(guard.begin(client.context), code('BIOMETRIC_REQUIRED'));
  await assert.rejects(guard.begin({ ...client.context, connection: undefined }), code('UNAUTHENTICATED'));
  client.disconnect();
  await assert.rejects(guard.begin(client.context), code('UNAUTHENTICATED'));
  assert.equal(created, 0);
  await guard.stop();
});

test('one reservation covers biometric wait; only the verified connection and session own it', async t => {
  const confirmation = deferred();
  let verifies = 0;
  const f = fixture({ verify: async (message, context) => {
    verifies++;
    assert.equal(message.type, 'input.begin');
    assert.equal(context, f.context);
    await confirmation.promise;
    return true;
  } });
  t.after(() => f.guard.stop());
  const start = f.guard.begin(f.context);
  await assert.rejects(f.guard.begin(peer().context), code('BUSY'));
  assert.equal(f.adapters.length, 0);
  confirmation.resolve();
  const session = await start;
  assert.equal(session.heartbeatTimeoutMs, 5_000);
  const wrong = { ...f.context, connection: { ...f.context.connection! } };
  assert.throws(() => f.guard.keepalive(wrong, session.controlSessionId), code('INPUT_SESSION_REQUIRED'));
  assert.throws(() => f.guard.keepalive({ ...f.context, session: { ...f.context.session, sessionId: randomUUID() } }, session.controlSessionId), code('INPUT_SESSION_REQUIRED'));
  f.guard.keepalive(f.context, session.controlSessionId);
  await f.guard.execute(f.context, session.controlSessionId, 1, async adapter => { adapter.held = true; });
  assert.equal(verifies, 1);
  await f.guard.end(f.context, session.controlSessionId);
  assert.deepEqual(f.adapters[0]!.calls, ['open', 'release', 'dispose']);
  assert.equal(f.adapters[0]!.held, false);
  await f.guard.begin(f.context);
  assert.equal(verifies, 2);
});

test('disconnect during biometric wait cancels the reservation; a late approval cannot open native input', async t => {
  const confirmation = deferred();
  const f = fixture({ verify: async () => { await confirmation.promise; return true; } });
  t.after(() => f.guard.stop());
  const start = f.guard.begin(f.context);
  const rejected = assert.rejects(start, code('UNAUTHENTICATED'));
  f.disconnect();
  await rejected;
  confirmation.resolve();
  await delay(0);
  assert.equal(f.adapters.length, 0);
});

test('revocation while awaiting verification rejects a late grant before native setup', async t => {
  const grant = deferred();
  const f = fixture({ verify: async () => { await grant.promise; return true; } });
  t.after(() => f.guard.stop());
  const start = f.guard.begin(f.context);
  const rejected = assert.rejects(start, code('UNAUTHENTICATED'));
  f.revoke();
  grant.resolve();
  await rejected;
  assert.equal(f.adapters.length, 0);
});

test('a verifier exception is redacted and does not leave the reservation busy', async () => {
  const f = fixture({ verify: async () => { throw new Error('SECRET biometric diagnostics'); } });
  await assert.rejects(f.guard.begin(f.context), code('INPUT_UNAVAILABLE'));
  await assert.rejects(f.guard.begin(f.context), code('INPUT_UNAVAILABLE'));
  assert.equal(f.adapters.length, 0);
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /SECRET|diagnostics/);
  await f.guard.stop();
});

test('disconnect during open waits for setup to settle and cleans partial native resources', async () => {
  const adapter = new FakeAdapter();
  const opening = deferred();
  const entered = deferred();
  adapter.open = async signal => {
    adapter.calls.push('open');
    entered.resolve();
    await opening.promise;
    assert.equal(signal.aborted, true);
  };
  const guard = new InputControlSession(() => adapter, new ActivityLog(), { verify: async () => true });
  const client = peer();
  const start = guard.begin(client.context);
  const rejected = assert.rejects(start, code('UNAUTHENTICATED'));
  await entered.promise;
  client.disconnect();
  assert.deepEqual(adapter.calls, ['open']);
  opening.resolve();
  await rejected;
  assert.deepEqual(adapter.calls, ['open', 'release', 'dispose']);
  await guard.stop();
});

test('disconnect before a queued batch enters native code prevents execution', async t => {
  const f = fixture();
  t.after(() => f.guard.stop());
  const { controlSessionId } = await f.guard.begin(f.context);
  const run = f.guard.execute(f.context, controlSessionId, 1, async () => assert.fail('Executed after disconnect'));
  const rejected = assert.rejects(run, code('UNAUTHENTICATED'));
  f.disconnect();
  await rejected;
  assert.deepEqual(f.adapters[0]!.calls, ['open', 'release', 'dispose']);
});

for (const reason of ['disconnect', 'revocation', 'expiry', 'shutdown'] as const) {
  test(`${reason} releases held inputs and disposes exactly once without another command`, async t => {
    const f = fixture();
    t.after(() => f.guard.stop());
    if (reason === 'expiry') f.context.session = { ...f.context.session, expiresAt: Date.now() + 200 };
    const { controlSessionId } = await f.guard.begin(f.context);
    await f.guard.execute(f.context, controlSessionId, 1, async adapter => { adapter.held = true; });
    if (reason === 'disconnect') f.disconnect();
    if (reason === 'revocation') f.revoke();
    if (reason === 'shutdown') await f.guard.stop();
    await waitFor(() => f.adapters[0]!.calls.includes('dispose'));
    await f.guard.stop();
    assert.equal(f.adapters[0]!.held, false);
    assert.deepEqual(f.adapters[0]!.calls, ['open', 'release', 'dispose']);
  });
}

test('heartbeat expiry releases without traffic; late keepalive cannot resurrect the lease', async t => {
  const f = fixture();
  t.after(() => f.guard.stop());
  const { controlSessionId } = await f.guard.begin(f.context);
  await f.guard.execute(f.context, controlSessionId, 1, async adapter => { adapter.held = true; });
  await waitFor(() => !f.adapters[0]!.held, INPUT_HEARTBEAT_TIMEOUT_MS + 1_000);
  assert.throws(() => f.guard.keepalive(f.context, controlSessionId), code('INPUT_SESSION_REQUIRED'));
});

test('batches are sequential and exclusive; duplicates/out-of-order writes do not enter the adapter', async t => {
  const f = fixture();
  t.after(() => f.guard.stop());
  const { controlSessionId } = await f.guard.begin(f.context);
  for (const sequence of [0, 2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.guard.execute(f.context, controlSessionId, sequence, async () => assert.fail('Invalid batch executed')), code('INPUT_SEQUENCE'));
  }
  const pending = deferred();
  const run = f.guard.execute(f.context, controlSessionId, 1, () => pending.promise);
  await assert.rejects(f.guard.execute(f.context, controlSessionId, 2, async () => {}), code('BUSY'));
  pending.resolve();
  await run;
  await assert.rejects(f.guard.execute(f.context, controlSessionId, 1, async () => {}), code('INPUT_SEQUENCE'));
  await f.guard.execute(f.context, controlSessionId, 2, async () => {});
});

test('disconnect waits for in-flight work before release and renewal requires new confirmation', async t => {
  let verifies = 0;
  const f = fixture({ verify: async () => { verifies++; return true; } });
  t.after(() => f.guard.stop());
  const { controlSessionId } = await f.guard.begin(f.context);
  const pending = deferred();
  const started = deferred();
  const run = f.guard.execute(f.context, controlSessionId, 1, async (adapter, signal) => {
    started.resolve();
    await pending.promise;
    assert.equal(signal.aborted, true);
    adapter.held = true; // Simulates a partial operation completing as disconnect arrives.
  });
  const rejected = assert.rejects(run, code('UNAUTHENTICATED'));
  await started.promise;
  f.disconnect();
  const renewed = peer();
  renewed.context.session = { ...renewed.context.session, deviceId: f.context.session.deviceId };
  await assert.rejects(f.guard.begin(renewed.context), code('BUSY'));
  assert.deepEqual(f.adapters[0]!.calls, ['open']);
  pending.resolve();
  await rejected;
  assert.equal(f.adapters[0]!.held, false);
  const next = await f.guard.begin(renewed.context);
  assert.notEqual(next.controlSessionId, controlSessionId);
  assert.equal(verifies, 2);
  assert.throws(() => f.guard.keepalive(renewed.context, controlSessionId), code('INPUT_SESSION_REQUIRED'));
});

test('failed batch releases partial input and returns only a safe error, never logs event contents', async t => {
  const f = fixture();
  t.after(() => f.guard.stop());
  const { controlSessionId } = await f.guard.begin(f.context);
  await assert.rejects(f.guard.execute(f.context, controlSessionId, 1, async adapter => {
    adapter.held = true;
    throw new Error('SECRET key identity and event contents');
  }), code('INPUT_UNAVAILABLE'));
  assert.equal(f.adapters[0]!.held, false);
  assert.doesNotMatch(JSON.stringify(f.log.snapshot()), /SECRET|key identity|event contents|controlSessionId/);
  await assert.rejects(f.guard.execute(f.context, controlSessionId, 1, async () => assert.fail()), code('INPUT_SESSION_REQUIRED'));
});

for (const failure of ['open', 'release', 'dispose'] as const) {
  test(`${failure} failure still cleans up; uncertain release/disposal blocks future control`, async () => {
    const adapter = new FakeAdapter();
    adapter[failure === 'release' ? 'releaseAll' : failure] = async () => { adapter.calls.push(failure); throw new Error('SECRET'); };
    const log = new ActivityLog();
    const guard = new InputControlSession(() => adapter, log, { verify: async () => true });
    const { context } = peer();
    if (failure === 'open') await assert.rejects(guard.begin(context), code('INPUT_UNAVAILABLE'));
    else {
      const { controlSessionId } = await guard.begin(context);
      await assert.rejects(guard.end(context, controlSessionId), code('INPUT_UNAVAILABLE'));
      await assert.rejects(guard.begin(context), code('INPUT_UNAVAILABLE'));
      assert.equal(log.snapshot().at(-1)?.eventType, 'input.release_failed');
    }
    assert.deepEqual(adapter.calls, ['open', 'release', 'dispose']);
    assert.doesNotMatch(JSON.stringify(log.snapshot()), /SECRET/);
    await guard.stop();
  });
}

test('hung native work bounds shutdown, quarantines control, and performs late cleanup if it settles', async () => {
  const f = fixture();
  const { controlSessionId } = await f.guard.begin(f.context);
  const pending = deferred();
  const entered = deferred();
  const run = f.guard.execute(f.context, controlSessionId, 1, async () => { entered.resolve(); await pending.promise; });
  const rejected = assert.rejects(run, code('UNAUTHENTICATED'));
  await entered.promise;
  const startedAt = Date.now();
  f.disconnect();
  await rejected;
  assert.ok(Date.now() - startedAt < INPUT_CLEANUP_TIMEOUT_MS + 2_000);
  await assert.rejects(f.guard.begin(peer().context), code('INPUT_UNAVAILABLE'));
  assert.equal(f.log.snapshot().at(-1)?.eventType, 'input.release_failed');
  pending.resolve();
  await waitFor(() => f.adapters[0]!.calls.includes('dispose'));
  await assert.rejects(f.guard.begin(peer().context), code('INPUT_UNAVAILABLE'));
  await f.guard.stop();
});

test('an adapter abort callback can reenter shutdown without duplicate release or disposal', async () => {
  const f = fixture();
  const { controlSessionId } = await f.guard.begin(f.context);
  const entered = deferred();
  const run = f.guard.execute(f.context, controlSessionId, 1, (_adapter, signal) => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => { void f.guard.stop(); resolve(); }, { once: true });
    entered.resolve();
  }));
  const rejected = assert.rejects(run, code('UNAUTHENTICATED'));
  await entered.promise;
  await f.guard.stop();
  await rejected;
  assert.deepEqual(f.adapters[0]!.calls, ['open', 'release', 'dispose']);
});
