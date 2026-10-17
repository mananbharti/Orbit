import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { SystemApi } from '../src/system.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new SystemApi(s) };
}

test('power, volume and brightness commands carry the documented payloads', async () => {
  const { s, api, calls } = await setup((type, _p) => type === 'system.power' ? { status: 'requested' }
    : type === 'system.volume.get' ? { level: 55, muted: false }
    : type === 'system.volume.set' ? { applied: true }
    : type === 'system.brightness.get' ? { level: 70 }
    : { applied: true });
  await api.power('lock');
  assert.deepEqual(calls.at(-1), { type: 'system.power', payload: { action: 'lock' } });
  assert.deepEqual(await api.getVolume(), { level: 55, muted: false });
  await api.setVolume(20, true);
  assert.deepEqual(calls.at(-1), { type: 'system.volume.set', payload: { level: 20, muted: true } });
  assert.equal(await api.getBrightness(), 70);
  await api.setBrightness(30);
  assert.deepEqual(calls.at(-1), { type: 'system.brightness.set', payload: { level: 30 } });
  s.stop();
});
test('a desktop without a controllable backlight reports null', async () => {
  const { s, api } = await setup(() => ({ level: null }));
  assert.equal(await api.getBrightness(), null);
  s.stop();
});
test('display mode commands carry the documented payloads and tolerate null fields', async () => {
  const { s, api, calls } = await setup(type => type === 'system.mode.get' ? { theme: 'light', nightLight: null } : { applied: true });
  assert.deepEqual(await api.getMode(), { theme: 'light', nightLight: null });
  await api.setMode({ theme: 'dark' });
  assert.deepEqual(calls.at(-1), { type: 'system.mode.set', payload: { theme: 'dark' } });
  s.stop();
});
test('a computer without theme support reports null theme', async () => {
  const { s, api } = await setup(() => ({ theme: null, nightLight: null }));
  assert.deepEqual(await api.getMode(), { theme: null, nightLight: null });
  s.stop();
});
test('panic returns the outcome and malformed replies are rejected', async () => {
  const { s, api, calls } = await setup(() => ({ status: 'locked' }));
  assert.equal(await api.panic(), 'locked');
  assert.deepEqual(calls.at(-1), { type: 'system.panic', payload: {} });
  s.stop();
});
test('malformed replies are rejected', async () => {
  const { s, api } = await setup(() => ({ level: 'loud' }));
  await assert.rejects(api.getVolume(), InvalidDesktopReply);
  s.stop();
});

test('audio sessions list and per-app set commands carry pids and bounded levels', async () => {
  const { s, api, calls } = await setup(type => type === 'system.audio.sessions'
    ? { sessions: [{ id: '4204', name: 'Spotify', volume: 80, muted: false }] } : { applied: true });
  assert.deepEqual(await api.audioSessions(), [{ id: '4204', name: 'Spotify', volume: 80, muted: false }]);
  await api.setAudioSession('4204', 25, true);
  assert.deepEqual(calls.at(-1), { type: 'system.audio.session.set', payload: { id: '4204', level: 25, muted: true } });
  await api.setAudioSession('4204', undefined, false);
  assert.deepEqual(calls.at(-1)!.payload, { id: '4204', muted: false });
  s.stop();
});
