import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession } from '../src/session.js';
import { SystemApi } from '../src/system.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, '0')}`;
async function reply(value: unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => t.last.reply(parseSent(text).requestId, value);
  return { api: new SystemApi(s), s };
}
const session = (extra: Record<string, unknown> = {}) => ({ id: '1234', name: 'Spotify', volume: 50, muted: false, ...extra });

test('every desktop reply is accepted only in its exact documented shape', async () => {
  const rejected: [string, (api: SystemApi) => Promise<unknown>, unknown][] = [
    ['power extra key', api => api.power('lock'), { status: 'requested', extra: 1 }],
    ['power wrong status', api => api.power('lock'), { status: 'done' }],
    ['volume above 100', api => api.getVolume(), { level: 101, muted: false }],
    ['volume below 0', api => api.getVolume(), { level: -1, muted: false }],
    ['volume fractional', api => api.getVolume(), { level: 1.5, muted: false }],
    ['brightness above 100', api => api.getBrightness(), { level: 101 }],
    ['brightness below 0', api => api.getBrightness(), { level: -1 }],
    ['brightness missing', api => api.getBrightness(), {}],
    ['applied false', api => api.setVolume(5), { applied: false }],
    ['panic unknown status', api => api.panic(), { status: 'ignored' }],
    ['audio id not digits', api => api.audioSessions(), { sessions: [session({ id: 'abc' })] }],
    ['audio id too long', api => api.audioSessions(), { sessions: [session({ id: '12345678901' })] }],
    ['audio empty name', api => api.audioSessions(), { sessions: [session({ name: '' })] }],
    ['audio long name', api => api.audioSessions(), { sessions: [session({ name: 'x'.repeat(129) })] }],
    ['audio volume above 100', api => api.audioSessions(), { sessions: [session({ volume: 101 })] }],
    ['audio volume fractional', api => api.audioSessions(), { sessions: [session({ volume: 5.5 })] }],
    ['too many sessions', api => api.audioSessions(), { sessions: Array.from({ length: 65 }, () => session()) }],
  ];
  for (const [label, call, value] of rejected) {
    const { api, s } = await reply(value);
    await assert.rejects(call(api), InvalidDesktopReply, label);
    s.stop();
  }
});

test('the exact limits are accepted', async () => {
  const volume = await reply({ level: 100, muted: true });
  assert.deepEqual(await volume.api.getVolume(), { level: 100, muted: true });
  const zero = await reply({ level: 0, muted: false });
  assert.equal((await zero.api.getVolume()).level, 0);
  const full = await reply({ sessions: Array.from({ length: 64 }, () => session({ id: '1234567890', name: 'x'.repeat(128), volume: 100 })) });
  assert.equal((await full.api.audioSessions()).length, 64);
  const none = await reply({ level: null });
  assert.equal(await none.api.getBrightness(), null);
  for (const r of [volume, zero, full, none]) r.s.stop();
});
