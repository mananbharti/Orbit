/** Tests System Control over real paired WSS with a fake OS adapter; depends on synthetic state only; never touches real power, volume or brightness. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from '../src/desktop-service.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import type { SystemControlAdapter } from '../src/os-integration/system-control.js';
import { MemoryClipboard, waitForClipboard as waitFor } from './clipboard-helpers.js';

async function fixture(t: TestContext, adapter: SystemControlAdapter) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-system-wss-'));
  const service = await startDesktop({ directory: join(root, 'service'), host: '127.0.0.1', port: 0, displayName: 'Orbit System Test',
    discovery: false, clipboard: { createAdapter: () => new MemoryClipboard(), pollMs: 10 }, system: { createAdapter: () => adapter } });
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired);
  t.after(async () => { client.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await client.start();
  return { client, service, paired };
}

function fakeAdapter(state: { calls: string[]; level: number; muted: boolean; brightness: number | null }): SystemControlAdapter {
  return {
    power: async action => { state.calls.push(`power:${action}`); },
    getVolume: async () => ({ level: state.level, muted: state.muted }),
    setVolume: async (level, muted) => { state.level = level; if (typeof muted === 'boolean') state.muted = muted; state.calls.push(`volume:${level}${state.muted ? ':muted' : ''}`); },
    getBrightness: async () => state.brightness,
    setBrightness: async level => { state.brightness = level; state.calls.push(`brightness:${level}`); },
  };
}

test('paired phone can lock, set volume and read brightness through System Control', { timeout: 30_000 }, async t => {
  const state = { calls: [] as string[], level: 40, muted: false, brightness: 70 as number | null };
  const f = await fixture(t, fakeAdapter(state));
  const power = await f.client.command('system.power', { action: 'lock' });
  assert.deepEqual(power.payload, { ok: true, result: { status: 'requested' } });
  const volume = await f.client.command('system.volume.get', {});
  assert.deepEqual(volume.payload, { ok: true, result: { level: 40, muted: false } });
  const setVolume = await f.client.command('system.volume.set', { level: 65, muted: true });
  assert.deepEqual(setVolume.payload, { ok: true, result: { applied: true } });
  const brightness = await f.client.command('system.brightness.get', {});
  assert.deepEqual(brightness.payload, { ok: true, result: { level: 70 } });
  await f.client.command('system.brightness.set', { level: 30 });
  assert.deepEqual(state.calls, ['power:lock', 'volume:65:muted', 'brightness:30']);
  assert.equal(state.brightness, 30);
});

test('a desktop without a controllable backlight reports null brightness', { timeout: 30_000 }, async t => {
  const state = { calls: [] as string[], level: 50, muted: false, brightness: null as number | null };
  const f = await fixture(t, fakeAdapter(state));
  const brightness = await f.client.command('system.brightness.get', {});
  assert.deepEqual(brightness.payload, { ok: true, result: { level: null } });
});

test('adapter failure surfaces as SYSTEM_UNAVAILABLE, not a crash', { timeout: 30_000 }, async t => {
  const failing: SystemControlAdapter = {
    power: async () => { throw new Error('no OS hooks'); },
    getVolume: async () => { throw new Error('no mixer'); },
    setVolume: async () => { throw new Error('no mixer'); },
    getBrightness: async () => { throw new Error('no backlight'); },
    setBrightness: async () => { throw new Error('no backlight'); },
  };
  const f = await fixture(t, failing);
  const power = await f.client.command('system.power', { action: 'sleep' });
  if (power.payload.ok) assert.fail('expected failure payload');
  assert.equal(power.payload.error.code, 'SYSTEM_UNAVAILABLE');
  const volume = await f.client.command('system.volume.get', {});
  if (volume.payload.ok) assert.fail('expected failure payload');
  assert.equal(volume.payload.error.code, 'SYSTEM_UNAVAILABLE');
});

test('invalid power actions are rejected before reaching the adapter', { timeout: 30_000 }, async t => {
  const state = { calls: [] as string[], level: 50, muted: false, brightness: 50 as number | null };
  const f = await fixture(t, fakeAdapter(state));
  const bad = await f.client.command('system.power', { action: 'format-disk' });
  if (bad.payload.ok) assert.fail('expected failure payload');
  assert.match(bad.payload.error.code, /INVALID/);
  assert.deepEqual(state.calls, []);
});

test('panic locks the machine and unpairs the phone immediately', { timeout: 30_000 }, async t => {
  const state = { calls: [] as string[], level: 50, muted: false, brightness: 50 as number | null };
  const f = await fixture(t, fakeAdapter(state));
  const panic = await f.client.command('system.panic', {});
  assert.deepEqual(panic.payload, { ok: true, result: { status: 'locked' } });
  assert.deepEqual(state.calls, ['power:lock']);
  await waitFor(() => !f.service.credentials.isActive(f.paired.deviceId));
  // The revoked phone's session dies: the next command is refused.
  await assert.rejects(f.client.command('system.volume.get', {}));
});

test('panic still unpairs when the machine cannot lock', { timeout: 30_000 }, async t => {
  const failing: SystemControlAdapter = {
    power: async () => { throw new Error('no OS hooks'); },
    getVolume: async () => ({ level: 0, muted: true }), setVolume: async () => {},
    getBrightness: async () => null, setBrightness: async () => {},
  };
  const f = await fixture(t, failing);
  const panic = await f.client.command('system.panic', {});
  assert.deepEqual(panic.payload, { ok: true, result: { status: 'unpaired' } });
  await waitFor(() => !f.service.credentials.isActive(f.paired.deviceId));
});
