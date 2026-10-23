/** Verifies the connection manager over real loopback sockets: auth gating, message validation, busy/refresh handling, targeted publish, heartbeat, shutdown; depends on ws and temp-free in-process servers only. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import type { CommandRouter } from '../src/command-router/command-router.js';
import { success, type CommandMessage, type ResponseMessage } from '../src/protocol/messages.js';
import type { Session, SessionAuth } from '../src/security-pairing/session-auth.js';
import { ConnectionManager } from '../src/transport/websocket/connection-manager.js';

const session: Session = { deviceId: 'phone-1', sessionId: 'sess-1', expiresAt: Date.now() + 60_000 };
const RID = '11111111-1111-4111-8111-111111111111';
const RID_FIRST = '22222222-2222-4222-8222-222222222222';
const RID_SECOND = '33333333-3333-4333-8333-333333333333';
const RID_REFRESH = '44444444-4444-4444-8444-444444444444';
const command = (type: string, requestId = RID): CommandMessage => ({ version: 1, type, requestId, payload: null });

interface Fixture {
  manager: ConnectionManager;
  log: ActivityLog;
  client: WebSocket;
  port: number;
  dispatchCalls: CommandMessage[];
  auth: { valid: boolean };
  takeMessages(): Promise<ResponseMessage[]>;
}

async function fixture(t: TestContext, dispatch: (message: CommandMessage) => Promise<ResponseMessage>, options: { heartbeatMs?: number; tokenSession?: Session } = {}): Promise<Fixture> {
  const log = new ActivityLog();
  const dispatchCalls: CommandMessage[] = [];
  const router = { dispatch: async (message: CommandMessage) => { dispatchCalls.push(message); return dispatch(message); } } as unknown as CommandRouter;
  const authState = { valid: true };
  const auth = { authenticate: () => (authState.valid ? session : undefined) } as unknown as SessionAuth;
  const manager = new ConnectionManager(router, auth, log, options.heartbeatMs ?? 30_000);
  const server = new WebSocketServer({ port: 0 });
  server.on('connection', socket => manager.attach(socket, 'token-1', options.tokenSession ?? session));
  t.after(async () => { manager.shutdown(); server.close(); await once(server, 'close').catch(() => {}); });
  const port = (server.address() as { port: number }).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, 'open');
  const received: ResponseMessage[] = [];
  const waiting: (() => void)[] = [];
  client.on('message', data => { received.push(JSON.parse(data.toString())); waiting.splice(0).forEach(resolve => resolve()); });
  const takeMessages = async (): Promise<ResponseMessage[]> => {
    if (!received.length) await Promise.race([new Promise<void>(resolve => waiting.push(resolve)), new Promise(resolve => setTimeout(resolve, 2_000))]);
    return received.splice(0);
  };
  return { manager, log, client, port, dispatchCalls, auth: authState, takeMessages };
}

const send = (client: WebSocket, value: unknown) => client.send(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

test('a valid command is dispatched and answered with the same request id', async t => {
  const f = await fixture(t, async message => success(message.requestId, { echoed: true }));
  send(f.client, command('clipboard.get'));
  const [reply] = await f.takeMessages();
  assert.deepEqual(reply, { version: 1, type: 'response', requestId: RID, payload: { ok: true, result: { echoed: true } } });
  assert.deepEqual(f.dispatchCalls.map(message => message.type), ['clipboard.get']);
  assert.ok(f.log.snapshot().some(event => event.eventType === 'connection.opened' && event.outcome === 'success'));
});

test('binary frames and malformed JSON are rejected without dispatch', async t => {
  const f = await fixture(t, async message => success(message.requestId, null));
  send(f.client, Buffer.from([1, 2, 3]));
  send(f.client, 'this is not json');
  send(f.client, JSON.stringify({ version: 2, type: 'clipboard.get', requestId: RID, payload: null }));
  const replies = await f.takeMessages();
  await tick();
  const all = [...replies, ...(await f.takeMessages())];
  assert.deepEqual(all.map(reply => reply.payload), [
    { ok: false, error: { code: 'INVALID_MESSAGE' } },
    { ok: false, error: { code: 'INVALID_MESSAGE' } },
    { ok: false, error: { code: 'UNSUPPORTED_VERSION' } },
  ]);
  assert.equal(f.dispatchCalls.length, 0);
  assert.ok(f.log.snapshot().filter(event => event.eventType === 'message.rejected').length >= 3);
});

test('a second command while one is in flight gets BUSY; session.refresh is rejected', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async message => { await gate; return success(message.requestId, null); });
  send(f.client, command('clipboard.get', RID_FIRST));
  await tick();
  send(f.client, command('clipboard.get', RID_SECOND));
  send(f.client, command('session.refresh', RID_REFRESH));
  const replies = await f.takeMessages();
  assert.deepEqual(replies.find(reply => reply.requestId === RID_SECOND)?.payload, { ok: false, error: { code: 'BUSY' } });
  assert.deepEqual(replies.find(reply => reply.requestId === RID_REFRESH)?.payload, { ok: false, error: { code: 'BUSY' } },
    'busy takes precedence even for session.refresh');
  release();
  const rest = await f.takeMessages();
  assert.deepEqual(rest.find(reply => reply.requestId === RID_FIRST)?.payload, { ok: true, result: null });
  assert.equal(f.dispatchCalls.length, 1, 'only the first command reached the router');
  send(f.client, command('session.refresh', RID_REFRESH));
  const refreshReplies = await f.takeMessages();
  assert.deepEqual(refreshReplies[0]!.payload, { ok: false, error: { code: 'UNKNOWN_COMMAND' } }, 'idle session.refresh is never dispatched');
});

test('a revoked session closes the socket with 4001 on the next message', async t => {
  const f = await fixture(t, async message => success(message.requestId, null));
  f.auth.valid = false;
  send(f.client, command('clipboard.get'));
  const [code, reason] = await once(f.client, 'close') as [number, Buffer];
  assert.equal(code, 4001);
  assert.match(reason.toString(), /expired or revoked/i);
  await tick();
  assert.equal(f.manager.size, 0);
  assert.ok(f.log.snapshot().some(event => event.eventType === 'authentication.rejected'));
});

test('an expiring session closes the socket at its expiry time', async t => {
  const expiring: Session = { ...session, expiresAt: Date.now() + 80 };
  const f = await fixture(t, async message => success(message.requestId, null), { tokenSession: expiring });
  const [code] = await once(f.client, 'close') as [number];
  assert.equal(code, 4001);
});

test('publish reaches only the matching device, with a validated event envelope', async t => {
  const f = await fixture(t, async message => success(message.requestId, null));
  assert.throws(() => f.manager.publish('phone-1', 'not a command', null), /Invalid event type/);
  f.manager.publish('phone-1', 'clipboard.changed', { source: 'pc' });
  f.manager.publish('other-phone', 'clipboard.changed', { source: 'pc' });
  const [event] = await f.takeMessages();
  assert.deepEqual(event, { version: 1, type: 'event', requestId: null, payload: { eventType: 'clipboard.changed', data: { source: 'pc' } } });
  await tick();
  assert.deepEqual(await f.takeMessages(), [], 'no event for other devices');
});

test('the heartbeat pings the client and the connection survives pongs', async t => {
  const f = await fixture(t, async message => success(message.requestId, null), { heartbeatMs: 150 });
  await once(f.client, 'ping');
  await tick(400);
  assert.equal(f.client.readyState, WebSocket.OPEN, 'client answered the ping and stayed connected');
  assert.equal(f.manager.size, 1);
});

test('shutdown closes every connection with 1001 and stops the heartbeat', async t => {
  const f = await fixture(t, async message => success(message.requestId, null));
  f.manager.shutdown();
  const [code] = await once(f.client, 'close') as [number];
  assert.equal(code, 1001);
  await tick();
  assert.equal(f.manager.size, 0);
});

test('a clean client close removes the connection and logs success', async t => {
  const f = await fixture(t, async message => success(message.requestId, null));
  f.client.close(1000);
  await once(f.client, 'close');
  await tick();
  assert.equal(f.manager.size, 0);
  const closed = f.log.snapshot().find(event => event.eventType === 'connection.closed');
  assert.equal(closed?.outcome, 'success');
});
