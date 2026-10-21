import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemApi } from '../src/system.js';
import { NotSent, type OrbitSession } from '../src/session.js';

function fake(status: string, handler: (type: string, payload: unknown) => unknown) {
  const calls: { type: string; payload: unknown }[] = [];
  const session = { get status() { return status; },
    command: async (type: string, payload: unknown) => { calls.push({ type, payload }); return handler(type, payload); },
  } as unknown as OrbitSession;
  return { session, calls };
}

test('not one system command reaches the wire while the session is not connected', async () => {
  const f = fake('reconnecting', () => { throw new Error('must not be called'); });
  const api = new SystemApi(f.session);
  await assert.rejects(api.power('shutdown'), NotSent);
  await assert.rejects(api.panic(), NotSent);
  await assert.rejects(api.setVolume(30), NotSent);
  await assert.rejects(api.getBrightness(), NotSent);
  await assert.rejects(api.setMode({ theme: 'dark' }), NotSent);
  await assert.rejects(api.audioSessions(), NotSent);
  await assert.rejects(api.setAudioSession('42', 50), NotSent);
  assert.deepEqual(f.calls, []);
});

test('optional fields are omitted from the payload, never sent as null or undefined', async () => {
  const f = fake('connected', type => type === 'system.audio.sessions' ? { sessions: [] } : { applied: true });
  const api = new SystemApi(f.session);
  await api.setAudioSession('42', undefined, true);
  await api.setAudioSession('7', 80);
  await api.setVolume(25);
  await api.setMode({ nightLight: true });
  assert.deepEqual(f.calls[0]!.payload, { id: '42', muted: true });
  assert.deepEqual(f.calls[1]!.payload, { id: '7', level: 80 });
  assert.deepEqual(f.calls[2]!.payload, { level: 25 });
  assert.deepEqual(f.calls[3]!.payload, { nightLight: true });
});
