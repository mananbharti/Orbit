import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandError, NotSent, OrbitSession, OutcomeUnknown, type SessionStatus } from '../src/session.js';
import { TransportError } from '../src/transport.js';
import { AuthenticationRejected, FakeTransport, DEVICE, paired, parseSent, sleep, token } from './fakes.js';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const make = (t = new FakeTransport(), over = {}) => ({ t, s: new OrbitSession(paired, t, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0, ...over }) });
const echo = (t: FakeTransport) => { t.last.onSend = text => { const m = parseSent(text); t.last.reply(m.requestId, { echo: m.type }); }; };

test('connects with the stored credential, then reports connected', async () => {
  const { t, s } = make();
  const seen: SessionStatus[] = []; s.onStatus(x => seen.push(x));
  await s.start();
  assert.equal(t.posts[0]!.path, '/v1/session');
  assert.equal(t.posts[0]!.token, token('c'));
  assert.deepEqual(seen, ['connecting', 'connected']);
  s.stop();
});
test('a command resolves with the result and uses a fresh request id', async () => {
  const { t, s } = make(); await s.start(); echo(t);
  assert.deepEqual(await s.command('agent.list', {}), { echo: 'agent.list' });
  await s.command('agent.list', {});
  const ids = t.last.sent.map(x => parseSent(x).requestId);
  assert.equal(new Set(ids).size, 2);
  s.stop();
});
test('desktop errors surface as CommandError with the code', async () => {
  const { t, s } = make(); await s.start();
  t.last.onSend = text => t.last.fail(parseSent(text).requestId, 'AGENT_INVALID_STATE');
  await assert.rejects(s.command('agent.cancel', {}), (e: CommandError) => e instanceof CommandError && e.code === 'AGENT_INVALID_STATE');
  s.stop();
});
test('commands are sent one at a time, in order', async () => {
  const { t, s } = make(); await s.start();
  const a = s.command('agent.list', {}); const b = s.command('agent.get', { taskId: 'x' });
  await sleep(5);
  assert.equal(t.last.sent.length, 1);
  t.last.reply(parseSent(t.last.sent[0]!).requestId, 1);
  assert.equal(await a, 1);
  await sleep(5);
  assert.equal(t.last.sent.length, 2);
  assert.equal(parseSent(t.last.sent[1]!).type, 'agent.get');
  t.last.reply(parseSent(t.last.sent[1]!).requestId, 2);
  assert.equal(await b, 2);
  s.stop();
});
test('a dropped connection makes the in-flight command OutcomeUnknown and queued ones NotSent, with no replay', async () => {
  const { t, s } = make(); await s.start();
  const first = s.command('agent.submit', { a: 1 }); const second = s.command('agent.list', {});
  await sleep(5);
  const old = t.last;
  old.drop();
  await assert.rejects(first, OutcomeUnknown);
  await assert.rejects(second, NotSent);
  await sleep(40);
  assert.equal(s.status, 'connected');
  assert.equal(old.sent.length, 1, 'old channel never got more sends');
  assert.equal(t.last.sent.length, 0, 'nothing is replayed on the new channel');
  s.stop();
});
test('a command that gets no answer times out as OutcomeUnknown and the channel is recycled', async () => {
  const { t, s } = make(new FakeTransport(), { commandTimeoutMs: 20 }); await s.start();
  await assert.rejects(s.command('agent.list', {}), OutcomeUnknown);
  assert.equal(t.channels[0]!.closed, true);
  await sleep(60);
  assert.equal(s.status, 'connected');
  s.stop();
});
test('commands are refused, not queued, while disconnected', async () => {
  const { s } = make();
  await assert.rejects(s.command('agent.list', {}), NotSent);
  await s.start(); s.stop();
  await assert.rejects(s.command('agent.list', {}), NotSent);
});
test('the command queue is bounded; the command past the cap is refused', async () => {
  const { t, s } = make(new FakeTransport(), { commandTimeoutMs: 5_000 }); await s.start();
  // One command is in flight; the next sixteen fill the queue (MAX_QUEUED).
  for (let i = 0; i < 17; i++) void s.command('agent.list', {}).catch(() => {});
  await assert.rejects(s.command('agent.list', {}), (e: NotSent) => e instanceof NotSent && e.message === 'Too many commands waiting');
  assert.equal(t.last.sent.length, 1, 'only the in-flight command reached the wire');
  s.stop();
});
test('immediate commands are capped; the fifth waiting one is refused', async () => {
  const { t, s } = make(new FakeTransport(), { commandTimeoutMs: 5_000 }); await s.start();
  for (let i = 0; i < 4; i++) void s.command('terminal.interrupt', { sessionId: 'x' }, { immediate: true }).catch(() => {});
  await assert.rejects(s.command('terminal.end', { sessionId: 'x' }, { immediate: true }),
    (e: NotSent) => e instanceof NotSent && e.message === 'Too many commands waiting');
  assert.equal(t.last.sent.length, 4, 'only the four admitted commands reached the wire');
  s.stop();
});
test('invalid or reserved command names and oversized payloads never reach the wire', async () => {
  const { t, s } = make(); await s.start();
  await assert.rejects(s.command('Bad Name', {}), NotSent);
  await assert.rejects(s.command('session.renew', {}), NotSent);
  await assert.rejects(s.command('agent.submit', { big: 'x'.repeat(70_000) }), NotSent);
  assert.equal(t.last.sent.length, 0);
  s.stop();
});
test('server events reach listeners; malformed server messages close the channel', async () => {
  const { t, s } = make(); await s.start();
  const events: unknown[] = []; s.onEvent(e => events.push(e));
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'agent.task', data: { a: 1 } } });
  assert.deepEqual(events, [{ eventType: 'agent.task', data: { a: 1 } }]);
  const bad = t.last;
  bad.deliver('not json');
  await sleep(40);
  assert.equal(bad.closed, true);
  assert.equal(s.status, 'connected');
  assert.notEqual(t.last, bad);
  s.stop();
});
test('a throwing event listener does not drop the connection', async () => {
  const { t, s } = make(); await s.start(); echo(t);
  const events: unknown[] = [];
  s.onEvent(() => { throw new Error('ui blew up'); });
  s.onEvent(e => events.push(e));
  t.last.deliver({ version: 1, type: 'event', requestId: null, payload: { eventType: 'agent.task', data: { a: 1 } } });
  assert.equal(s.status, 'connected');
  assert.equal(t.last.closed, false, 'a local listener bug is not a protocol violation');
  assert.deepEqual(events, [{ eventType: 'agent.task', data: { a: 1 } }], 'later listeners still receive the event');
  assert.deepEqual(await s.command('agent.list', {}), { echo: 'agent.list' }, 'commands still flow');
  s.stop();
});
test('a response with an unknown id is ignored', async () => {
  const { t, s } = make(); await s.start();
  const p = s.command('agent.list', {}); await sleep(5);
  t.last.reply('99999999-9999-4999-8999-999999999999', 'wrong');
  t.last.reply(parseSent(t.last.sent[0]!).requestId, 'right');
  assert.equal(await p, 'right');
  s.stop();
});
test('rejected credentials stop retrying and ask for re-pairing', async () => {
  const { t, s } = make(); await s.start();
  t.failPost = new AuthenticationRejected();
  t.last.drop();
  await sleep(60);
  assert.equal(s.status, 'authentication-required');
  const posts = t.posts.length;
  await sleep(60);
  assert.equal(t.posts.length, posts, 'no further attempts');
  s.stop();
});
test('a session for another device is treated as rejected', async () => {
  const t = new FakeTransport();
  t.postResult = () => ({ version: 1, deviceId: '33333333-3333-4333-8333-333333333333', sessionId: DEVICE, expiresAt: Date.now() + 9e5, sessionToken: token('s') });
  const { s } = make(t);
  await assert.rejects(s.start(), AuthenticationRejected);
  assert.equal(s.status, 'stopped');
});
test('a session reply that is already expired is treated as rejected', async () => {
  const t = new FakeTransport();
  t.postResult = () => ({ version: 1, deviceId: DEVICE, sessionId: DEVICE, expiresAt: Date.now() - 1, sessionToken: token('s') });
  const { s } = make(t);
  await assert.rejects(s.start(), AuthenticationRejected);
  assert.equal(s.status, 'stopped');
});
test('transient network failures back off and recover', async () => {
  const { t, s } = make(); await s.start();
  t.failPost = new Error('offline');
  t.last.drop();
  await sleep(50);
  assert.equal(s.status, 'reconnecting');
  t.failPost = undefined;
  await sleep(80);
  assert.equal(s.status, 'connected');
  s.stop();
});
test('a lost desktop is found through the locator once per cooldown, and the new address is persisted', async () => {
  let now = 1_000_000;
  let finds = 0;
  const changed: string[] = [];
  const t = new FakeTransport();
  const locator = { find: async () => { finds++; return { endpoint: 'wss://192.168.1.99:8443/v1/channel',
    raw: { version: 1, deviceId: DEVICE, sessionId: DEVICE, expiresAt: now + 9e5, sessionToken: token('s') } }; } };
  const { s } = make(t, { locator, onEndpointChanged: (e: string) => changed.push(e), now: () => now });
  t.failPost = new TransportError('unreachable');
  await s.start();
  assert.equal(s.status, 'connected');
  assert.equal(finds, 1);
  assert.deepEqual(changed, ['wss://192.168.1.99:8443/v1/channel']);
  t.last.drop();
  await sleep(60); // several retries, all inside the cooldown window
  assert.equal(finds, 1, 'no second search inside the cooldown');
  assert.equal(s.status, 'reconnecting');
  now += 9_000;
  await sleep(80);
  assert.equal(finds, 2, 'a failure after the cooldown searches again');
  assert.equal(s.status, 'connected');
  s.stop();
});
test('a session token authorizes a bounded run of commands, then renews itself', async () => {
  const t = new FakeTransport();
  const { s } = make(t, { renewAfterCommands: 2 });
  await s.start();
  echo(t);
  await s.command('a.one', {});
  await s.command('a.two', {});
  await assert.rejects(s.command('a.three', {}), NotSent); // the next command on the same token is refused
  await sleep(80); // the renewal runs: a fresh session post, a fresh channel
  assert.ok(t.posts.filter(p => p.path === '/v1/session').length >= 2, 'a fresh session was requested');
  echo(t);
  assert.deepEqual(await s.command('a.four', {}), { echo: 'a.four' });
  s.stop();
});
test('the session renews itself before expiry', async () => {
  const t = new FakeTransport(); t.sessionExpiresIn = 100;
  const { s } = make(t); await s.start();
  await sleep(150);
  assert.ok(t.posts.filter(p => p.path === '/v1/session').length >= 2);
  s.stop();
});
test('stop is final: no retries and pending work is failed', async () => {
  const { t, s } = make(); await s.start();
  const p = s.command('agent.list', {}); await sleep(5);
  s.stop();
  await assert.rejects(p, OutcomeUnknown);
  const posts = t.posts.length;
  await sleep(50);
  assert.equal(t.posts.length, posts);
  assert.equal(s.status, 'stopped');
});
