import assert from 'node:assert/strict';
import test from 'node:test';
import { OrbitSession, OutcomeUnknown } from '../src/session.js';
import { FakeTransport, paired, parseSent, sleep } from './fakes.js';

let n = 0;
const uuid = () => `99999999-9999-4999-8999-${String(++n).padStart(12, '0')}`;
async function connect() {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  return { t, s };
}

test('a reply arriving on the previous channel is not trusted for a command on the new one', async () => {
  const { t, s } = await connect();
  const old = t.last;
  old.drop();
  await sleep(40);
  assert.equal(s.status, 'connected');
  assert.notEqual(t.last, old);
  const fresh = t.last;
  let requestId = '';
  fresh.onSend = text => { requestId = parseSent(text).requestId; };
  const cmd = s.command('tabs.status', {});
  await sleep(5);
  old.deliver({ version: 1, type: 'response', requestId, payload: { ok: true, result: 'STALE' } });
  assert.equal(await Promise.race([cmd, sleep(30).then(() => 'pending')]), 'pending');
  fresh.reply(requestId, 'FRESH');
  assert.equal(await cmd, 'FRESH');
  s.stop();
});
test('a late close from the previous channel does not tear down the new one', async () => {
  const { t, s } = await connect();
  const old = t.last;
  old.drop();
  await sleep(40);
  assert.equal(s.status, 'connected');
  const fresh = t.last;
  let requestId = '';
  fresh.onSend = text => { requestId = parseSent(text).requestId; };
  const cmd = s.command('tabs.status', {});
  await sleep(5);
  old.handlers.onClose();
  assert.equal(s.status, 'connected');
  fresh.reply(requestId, 'ok');
  assert.equal(await cmd, 'ok');
  s.stop();
});
test('an immediate command in flight when the connection drops is OutcomeUnknown, never replayed', async () => {
  const { t, s } = await connect();
  t.last.onSend = () => {};
  const cmd = s.command('terminal.end', { sessionId: 'x' }, { immediate: true });
  await sleep(5);
  t.last.drop();
  await assert.rejects(cmd, OutcomeUnknown);
  s.stop();
});
test('an immediate command that gets no answer times out as OutcomeUnknown and recycles the channel', async () => {
  const t = new FakeTransport();
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, random: () => 0 });
  await s.start();
  t.last.onSend = () => {};
  const cmd = s.command('terminal.interrupt', { sessionId: 'x' }, { immediate: true, timeoutMs: 20 });
  await assert.rejects(cmd, OutcomeUnknown);
  await sleep(60);
  assert.equal(s.status, 'connected');
  assert.ok(t.channels.length >= 2);
  s.stop();
});
