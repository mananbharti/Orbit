/** Verifies the panic lock: authorized phones only, best-effort lock, guaranteed unpair after the reply, audit record; depends on temp directories only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import type { CommandConnection, CommandContext } from '../src/command-router/command-context.js';
import type { SystemControlAdapter } from '../src/os-integration/system-control.js';
import { PanicLock } from '../src/security-pairing/panic-lock.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';

function lockAdapter(behavior: 'works' | 'fails'): SystemControlAdapter {
  return {
    power: async () => { if (behavior === 'fails') throw new Error('no lock command on this platform'); },
    getVolume: async () => ({ level: 50, muted: false }),
    setVolume: async () => {},
    getBrightness: async () => null,
    setBrightness: async () => {},
    getDisplayMode: async () => ({ theme: null, nightLight: null }),
    setDisplayMode: async () => ({ theme: null, nightLight: null }),
  } as unknown as SystemControlAdapter;
}

function fixture(t: TestContext, behavior: 'works' | 'fails' | 'missing') {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-panic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new CommandRegistry();
  const credentials = new FilePairedCredentialStore(join(directory, 'credentials.json'));
  const { deviceId } = credentials.enroll();
  const log = new ActivityLog();
  const panic = new PanicLock(registry, credentials,
    behavior === 'missing' ? undefined : () => lockAdapter(behavior), log);
  t.after(() => panic.stop());
  const connection: CommandConnection = { id: 'conn-1', closed: new AbortController().signal,
    isAuthorized: () => true, publish: () => {} };
  const context: CommandContext = { session: { deviceId, sessionId: 'sess-1', expiresAt: Date.now() + 60_000 }, requestId: 'req-1', connection };
  return { registry, credentials, log, deviceId, context };
}

function handler(registry: CommandRegistry) {
  const found = registry.get('system.panic');
  assert.ok(found, 'system.panic is registered');
  return found;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 150));

test('an unauthorized connection cannot trigger the panic lock', async t => {
  const { registry, credentials, context, deviceId } = fixture(t, 'works');
  const intruder: CommandContext = { ...context, connection: { ...context.connection!, isAuthorized: () => false } };
  await assert.rejects(handler(registry).execute(null, intruder), /UNAUTHENTICATED/);
  const missing: CommandContext = { session: context.session, requestId: 'req-2' };
  await assert.rejects(handler(registry).execute(null, missing), /UNAUTHENTICATED/);
  await settle();
  assert.equal(credentials.isActive(deviceId), true, 'nothing is unpaired');
});

test('a successful lock reports "locked", then unpairs the phone a tick after the reply', async t => {
  const { registry, credentials, log, context, deviceId } = fixture(t, 'works');
  const result = await handler(registry).execute(null, context);
  assert.deepEqual(result, { status: 'locked' });
  assert.equal(credentials.isActive(deviceId), true, 'the unpair is deferred until the reply is written');
  await settle();
  assert.equal(credentials.isActive(deviceId), false, 'the phone is unpaired');
  const events = log.snapshot().filter(event => event.eventType === 'system.panic');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.severity, 'warn');
  assert.equal(events[0]!.deviceId, deviceId);
  assert.equal(events[0]!.outcome, 'success');
});

test('a machine that cannot lock still unpairs and reports "unpaired"', async t => {
  for (const behavior of ['fails', 'missing'] as const) {
    const { registry, credentials, context, deviceId } = fixture(t, behavior);
    const result = await handler(registry).execute(null, context);
    assert.deepEqual(result, { status: 'unpaired' });
    await settle();
    assert.equal(credentials.isActive(deviceId), false, `unpair runs with adapter behavior ${behavior}`);
  }
});

test('stop() unregisters the command', () => {
  const registry = new CommandRegistry();
  const panic = new PanicLock(registry, new FilePairedCredentialStore(), undefined, new ActivityLog());
  assert.throws(() => new PanicLock(registry, new FilePairedCredentialStore(), undefined, new ActivityLog()), /duplicate/);
  panic.stop();
  assert.equal(registry.get('system.panic'), undefined);
});
