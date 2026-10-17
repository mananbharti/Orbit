/** Tests the per-app audio mixer over real paired WSS with a fake OS adapter; depends on synthetic sessions; never touches real audio. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDesktop } from '../src/desktop-service.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import type { AudioMixerAdapter, AudioSession } from '../src/os-integration/audio-mixer.js';
import { AudioMixerUnavailable } from '../src/os-integration/audio-mixer.js';
import { MemoryClipboard } from './clipboard-helpers.js';

async function fixture(t: TestContext, adapter: AudioMixerAdapter) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-mixer-wss-'));
  const service = await startDesktop({ directory: join(root, 'service'), host: '127.0.0.1', port: 0, displayName: 'Orbit Mixer Test',
    discovery: false, clipboard: { createAdapter: () => new MemoryClipboard(), pollMs: 10 },
    system: false, audioMixer: { createAdapter: () => adapter } });
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired);
  t.after(async () => { client.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await client.start();
  return { client };
}

test('a paired phone lists app sessions and changes one app volume and mute', { timeout: 30_000 }, async t => {
  const sessions: AudioSession[] = [
    { id: '4204', name: 'Spotify', volume: 80, muted: false },
    { id: '512', name: 'Discord', volume: 35, muted: true },
  ];
  const sets: [string, number | undefined, boolean | undefined][] = [];
  const adapter: AudioMixerAdapter = {
    listSessions: async () => sessions.map(session => ({ ...session })),
    setSession: async (id, level, muted) => {
      const session = sessions.find(s => s.id === id);
      if (!session) throw new AudioMixerUnavailable('gone');
      if (level !== undefined) session.volume = level;
      if (muted !== undefined) session.muted = muted;
      sets.push([id, level, muted]);
    },
  };
  const f = await fixture(t, adapter);
  const listed = await f.client.command('system.audio.sessions', {});
  assert.deepEqual(listed.payload, { ok: true, result: { sessions } });
  const set = await f.client.command('system.audio.session.set', { id: '4204', level: 25 });
  assert.deepEqual(set.payload, { ok: true, result: { applied: true } });
  const mute = await f.client.command('system.audio.session.set', { id: '512', muted: false });
  assert.deepEqual(mute.payload, { ok: true, result: { applied: true } });
  assert.deepEqual(sets, [['4204', 25, undefined], ['512', undefined, false]]);
  assert.equal(sessions[0]!.volume, 25);
  assert.equal(sessions[1]!.muted, false);
});

test('a session that disappeared and a set with nothing to change fail cleanly', { timeout: 30_000 }, async t => {
  const adapter: AudioMixerAdapter = {
    listSessions: async () => [],
    setSession: async () => { throw new AudioMixerUnavailable('gone'); },
  };
  const f = await fixture(t, adapter);
  const gone = await f.client.command('system.audio.session.set', { id: '9999', level: 50 });
  if (gone.payload.ok) assert.fail('expected failure payload');
  assert.equal(gone.payload.error.code, 'SYSTEM_UNAVAILABLE');
  const empty = await f.client.command('system.audio.session.set', { id: '4204' });
  if (empty.payload.ok) assert.fail('expected failure payload');
  assert.equal(empty.payload.error.code, 'INVALID_PAYLOAD');
  const badId = await f.client.command('system.audio.session.set', { id: 'spotify.exe', level: 50 });
  if (badId.payload.ok) assert.fail('expected failure payload');
  assert.equal(badId.payload.error.code, 'INVALID_PAYLOAD');
});
