/** System control write paths against a real desktop service with a stateful adapter: what the phone sets is what the adapter gets and what it reads back. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { SystemControlUnavailable } from '../../../desktop/src/os-integration/system-control.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { SystemApi } from '../../core/src/system.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext, failing = false) {
  const state = { volume: 40, muted: false, brightness: 70 as number | null, theme: 'light' as 'dark' | 'light' | null, nightLight: false as boolean | null };
  const root = mkdtempSync(join(tmpdir(), 'orbit-system-w-'));
  const fail = async () => { throw new SystemControlUnavailable(); };
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    system: { createAdapter: () => ({
      power: async () => {},
      getVolume: async () => ({ level: state.volume, muted: state.muted }),
      setVolume: failing ? fail : async (level, muted) => { state.volume = level; if (muted !== undefined) state.muted = muted; },
      getBrightness: async () => state.brightness,
      setBrightness: async level => { state.brightness = level; },
      getDisplayMode: async () => ({ theme: state.theme, nightLight: state.nightLight }),
      setDisplayMode: async mode => { if (mode.theme) state.theme = mode.theme; if (mode.nightLight !== undefined) state.nightLight = mode.nightLight; },
    }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { system: new SystemApi(session), state };
}

test('volume set reaches the adapter and reads back, mute is independent of level', async t => {
  const { system, state } = await phone(t);
  await system.setVolume(65);
  assert.equal(state.volume, 65);
  assert.deepEqual(await system.getVolume(), { level: 65, muted: false });
  await system.setVolume(65, true);
  assert.deepEqual(await system.getVolume(), { level: 65, muted: true });
});

test('brightness and display mode writes reach the adapter; a partial mode change leaves the other field alone', async t => {
  const { system, state } = await phone(t);
  await system.setBrightness(25);
  assert.equal(state.brightness, 25);
  assert.equal(await system.getBrightness(), 25);
  await system.setMode({ theme: 'dark' });
  assert.deepEqual(await system.getMode(), { theme: 'dark', nightLight: false });
  await system.setMode({ nightLight: true });
  assert.deepEqual(await system.getMode(), { theme: 'dark', nightLight: true });
});

test('out-of-range and empty writes are refused before the adapter is touched', async t => {
  const { system, state } = await phone(t);
  for (const bad of [-1, 101, 50.5]) {
    await assert.rejects(() => system.setVolume(bad), CommandError);
    await assert.rejects(() => system.setBrightness(bad), CommandError);
  }
  await assert.rejects(() => system.setMode({}), CommandError);
  assert.equal(state.volume, 40);
  assert.equal(state.brightness, 70);
});

test('an adapter that cannot write is an honest SYSTEM_UNAVAILABLE and the session keeps working', async t => {
  const { system } = await phone(t, true);
  await assert.rejects(() => system.setVolume(10), (e: unknown) => e instanceof CommandError && e.code === 'SYSTEM_UNAVAILABLE');
  assert.equal((await system.getVolume()).level, 40, 'reads still work after a failed write');
});
