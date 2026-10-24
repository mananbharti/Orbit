import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApi, InvalidDesktopReply } from '../src/agent.js';
import { NotSent, OrbitSession } from '../src/session.js';
import { FakeTransport, paired, parseSent } from './fakes.js';

const TASK = '44444444-4444-4444-8444-444444444444';
const summary = (state = 'running') => ({ taskId: TASK, state, createdAt: 1, updatedAt: 2, headline: 'Working' });
let n = 0;
const uuid = () => `55555555-5555-4555-8555-${String(++n).padStart(12, '0')}`;
async function setup(handler: (type: string, payload: any) => unknown) {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = text => { const m = parseSent(text); t.last.reply(m.requestId, handler(m.type, m.payload)); };
  return { t, s, api: new AgentApi(s, uuid) };
}

test('submit trims, sends an idempotency key and parses the summary', async () => {
  let seen: any;
  const { s, api } = await setup((_t, p) => { seen = p; return summary('queued'); });
  const r = await api.submit('  open my notes  ', '66666666-6666-4666-8666-666666666666');
  assert.deepEqual(seen, { prompt: 'open my notes', idempotencyKey: '66666666-6666-4666-8666-666666666666' });
  assert.equal(r.state, 'queued');
  s.stop();
});
test('answer-only is sent only when explicitly chosen, never by default', async () => {
  let seen: any;
  const { s, api } = await setup((_t, p) => { seen = p; return summary('queued'); });
  await api.submit('what is the capital of France', undefined, { answerOnly: true });
  assert.equal(seen.answerOnly, true);
  await api.submit('book the cheapest flight');
  assert.equal(seen.answerOnly, undefined, 'a normal task must not carry the flag at all (older desktops use a strict schema)');
  s.stop();
});
test('status parses the answer-only capability, defaulting off with older desktops', async () => {
  const { s, api } = await setup(() => ({ paused: false, answerOnly: true }));
  assert.deepEqual(await api.status(), { paused: false, answerOnly: true });
  s.stop();
  const older = await setup(() => ({ paused: true }));
  assert.deepEqual(await older.api.status(), { paused: true, answerOnly: false });
  older.s.stop();
});
test('submit generates a key when none is given', async () => {
  let seen: any;
  const { s, api } = await setup((_t, p) => { seen = p; return summary(); });
  await api.submit('hi');
  assert.match(seen.idempotencyKey, /^[0-9a-f-]{36}$/);
  s.stop();
});
test('empty and oversized prompts are refused before sending', async () => {
  const { t, s, api } = await setup(() => summary());
  await assert.rejects(api.submit('   '), NotSent);
  await assert.rejects(api.submit('x'.repeat(8 * 1024 + 1)), NotSent);
  assert.equal(t.last.sent.length, 0);
  s.stop();
});
test('list, get, cancel and approve call the right commands', async () => {
  const calls: string[] = [];
  const { s, api } = await setup(type => {
    calls.push(type);
    if (type === 'agent.list') return { tasks: [summary()] };
    if (type === 'agent.approve') return { status: 'approved' };
    return summary('cancelled');
  });
  assert.equal((await api.list()).length, 1);
  assert.equal((await api.get(TASK)).taskId, TASK);
  assert.equal((await api.cancel(TASK)).state, 'cancelled');
  assert.equal(await api.approve(TASK, true, '22222222-2222-4222-8222-222222222222'), 'approved');
  assert.deepEqual(calls, ['agent.list', 'agent.get', 'agent.cancel', 'agent.approve']);
  s.stop();
});
test('events follows pages until hasMore is false', async () => {
  const ev = (seq: number) => ({ seq, at: seq, kind: 'step', text: `s${seq}` });
  const afters: number[] = [];
  const { s, api } = await setup((_t, p) => {
    afters.push(p.afterSeq);
    return p.afterSeq === 0 ? { events: [ev(1), ev(2)], hasMore: true } : { events: [ev(3)], hasMore: false };
  });
  assert.deepEqual((await api.events(TASK)).map(e => e.seq), [1, 2, 3]);
  assert.deepEqual(afters, [0, 2]);
  s.stop();
});
test('unexpected desktop replies are rejected, not trusted', async () => {
  const { s, api } = await setup(() => ({ taskId: 'nope' }));
  await assert.rejects(api.get(TASK), InvalidDesktopReply);
  await assert.rejects(api.list(), InvalidDesktopReply);
  s.stop();
});
test('audit returns parsed entries and rejects malformed ones', async () => {
  const entry = { at: 1, taskId: TASK, deviceId: TASK, kind: 'approved' };
  const ok = await setup(() => ({ entries: [entry] }));
  assert.equal((await ok.api.audit())[0]!.kind, 'approved');
  ok.s.stop();
  const bad = await setup(() => ({ entries: [{ ...entry, kind: 'nope' }] }));
  await assert.rejects(bad.api.audit(), InvalidDesktopReply);
  bad.s.stop();
});
test('safe mode calls map to status, pause and resume and validate replies', async () => {
  const calls: string[] = [];
  const { s, api } = await setup(type => { calls.push(type); return { paused: type !== 'agent.resume' }; });
  assert.equal(await api.safeMode(), true);
  await api.pause(); await api.resume();
  assert.deepEqual(calls, ['agent.status', 'agent.pause', 'agent.resume']);
  s.stop();
  const bad = await setup(() => ({ paused: 'yes' }));
  await assert.rejects(bad.api.pause(), InvalidDesktopReply);
  bad.s.stop();
});
