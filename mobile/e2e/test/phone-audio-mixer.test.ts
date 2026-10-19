/** Per-app audio mixer writes against a real desktop service with a stateful adapter. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { AudioMixerUnavailable } from '../../../desktop/src/os-integration/audio-mixer.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { CommandError, OrbitSession } from '../../core/src/session.js';
import { SystemApi } from '../../core/src/system.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

async function phone(t: TestContext) {
  const sessions = [{ id: '4012', name: 'Spotify', volume: 80, muted: false }, { id: '5530', name: 'Chrome', volume: 30, muted: false }];
  const root = mkdtempSync(join(tmpdir(), 'orbit-mixer-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false,
    audioMixer: { createAdapter: () => ({
      listSessions: async () => { return sessions.map(s => ({ ...s })); },
      setSession: async (id, level, muted) => {
        const s = sessions.find(x => x.id === id);
        if (!s) throw new AudioMixerUnavailable('gone');
        if (level !== undefined) s.volume = level;
        if (muted !== undefined) s.muted = muted;
      } }) } });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return new SystemApi(session);
}

test('one app can be turned down and muted without touching the others', async t => {
  const system = await phone(t);
  await system.setAudioSession('4012', 15);
  await system.setAudioSession('5530', undefined, true);
  const list = await system.audioSessions();
  assert.deepEqual(list.map(s => [s.name, s.volume, s.muted]), [['Spotify', 15, false], ['Chrome', 30, true]]);
});

test('invalid mixer writes are refused: bad id, out of range, nothing to set', async t => {
  const system = await phone(t);
  await assert.rejects(() => system.setAudioSession('not-a-pid', 10), CommandError);
  await assert.rejects(() => system.setAudioSession('4012', 101), CommandError);
  await assert.rejects(() => system.setAudioSession('4012'), CommandError);
  assert.equal((await system.audioSessions())[0]!.volume, 80, 'nothing changed');
});

test('an app that has closed is SYSTEM_UNAVAILABLE and the session survives', async t => {
  const system = await phone(t);
  await assert.rejects(() => system.setAudioSession('9999', 10), (e: unknown) => e instanceof CommandError && e.code === 'SYSTEM_UNAVAILABLE');
  assert.equal((await system.audioSessions()).length, 2);
});
