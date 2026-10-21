import assert from 'node:assert/strict';
import test from 'node:test';
import { InputApi } from '../src/input.js';
import { OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

let n = 0;
const uuid = () => `88888888-8888-4888-8888-${String(++n).padStart(12, '0')}`;
async function setup() {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  const sends: any[] = [];
  let seq = 1;
  t.last.onSend = text => {
    const m = parseSent(text) as { type: string; requestId: string; payload: any };
    if (m.type === 'input.begin') return t.last.reply(m.requestId, { controlSessionId: '77777777-7777-4777-8777-777777777777', nextSequence: seq, heartbeatTimeoutMs: 5000 });
    if (m.type === 'input.send') { sends.push(m.payload); seq = m.payload.sequence + 1; return t.last.reply(m.requestId, { nextSequence: seq }); }
    t.last.reply(m.requestId, {});
  };
  const api = new InputApi(s);
  await api.begin();
  return { api, s, sends };
}

test('a NaN or infinite pointer value is neutralised instead of ending the control session', async () => {
  const { api, s, sends } = await setup();
  api.push({ t: 'move', dx: Number.NaN, dy: 5 });
  await api.flush();
  api.push({ t: 'scroll', dx: Number.POSITIVE_INFINITY, dy: Number.NEGATIVE_INFINITY });
  await api.flush();
  assert.equal(api.getState().status, 'active', JSON.stringify(api.getState()));
  assert.deepEqual(sends[0].events[0], { t: 'move', dx: 0, dy: 5 });
  assert.deepEqual(sends[1].events[0], { t: 'scroll', dx: 2000, dy: -2000 });
  await api.end(); api.dispose(); s.stop();
});

test('text is cut to the limit and moves merge only up to the step cap', async () => {
  const { api, s, sends } = await setup();
  api.push({ t: 'text', text: 'x'.repeat(100) });
  api.push({ t: 'move', dx: 1500, dy: 0 });
  api.push({ t: 'move', dx: 1500, dy: 0 });
  await api.flush();
  const events = sends.flatMap(p => p.events);
  assert.equal(events[0].text.length, 64);
  assert.deepEqual(events.slice(1).map((e: any) => e.dx), [1500, 1500]);
  await api.end(); api.dispose(); s.stop();
});

test('more than 32 queued events go out in batches of 32 with consecutive sequence numbers', async () => {
  const { api, s, sends } = await setup();
  for (let i = 0; i < 70; i++) api.push({ t: 'key', key: 'a' });
  await api.flush();
  const batches = sends.map(p => p.events.length);
  assert.equal(batches.reduce((a, b) => a + b, 0), 70);
  assert.ok(batches.every(b => b <= 32), batches.join(','));
  sends.forEach((p, i) => i && assert.equal(p.sequence, sends[i - 1].sequence + 1));
  await api.end(); api.dispose(); s.stop();
});
