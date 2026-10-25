import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidDesktopReply } from '../src/agent.js';
import { OrbitSession, NotSent } from '../src/session.js';
import { NlControlApi } from '../src/nl-control.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const calls: { type: string; payload: any }[] = [];
  t.last.onSend = text => { const m = parseSent(text); calls.push({ type: m.type, payload: m.payload }); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, calls, api: new NlControlApi(s) };
}

test('say sends nl.control with the phrase and parses the outcome', async () => {
  const { s, api, calls } = await setup(() => ({ status: 'executed', command: 'system.volume.set', result: { applied: true } }));
  const out = await api.say('volume 50');
  assert.deepEqual(calls.at(-1), { type: 'nl.control', payload: { text: 'volume 50' } });
  assert.deepEqual(out, { status: 'executed', command: 'system.volume.set', result: { applied: true } });
  s.stop();
});

test('rejected, unclear and unknown outcomes all parse', async () => {
  const { s, api } = await setup(() => ({ status: 'rejected', command: 'system.volume.set', error: 'SCOPE_DENIED' }));
  assert.deepEqual(await api.say('volume 50'), { status: 'rejected', command: 'system.volume.set', error: 'SCOPE_DENIED' });
  s.stop();
  const f2 = await setup(() => ({ status: 'unclear', hint: 'say a number from 0 to 100' }));
  assert.deepEqual(await f2.api.say('volume up'), { status: 'unclear', hint: 'say a number from 0 to 100' });
  f2.s.stop();
  const f3 = await setup(() => ({ status: 'unknown' }));
  assert.deepEqual(await f3.api.say('make me a sandwich'), { status: 'unknown' });
  f3.s.stop();
});

test('empty and over-long phrases never leave the phone', async () => {
  const { s, api, calls } = await setup(() => ({ status: 'unknown' }));
  await assert.rejects(api.say(''), NotSent);
  await assert.rejects(api.say('x'.repeat(201)), NotSent);
  assert.equal(calls.length, 0);
  s.stop();
});

test('a junk desktop reply is an InvalidDesktopReply, not a guess', async () => {
  const { s, api } = await setup(() => ({ status: 'executed-ish' }));
  await assert.rejects(api.say('volume 50'), InvalidDesktopReply);
  s.stop();
});
