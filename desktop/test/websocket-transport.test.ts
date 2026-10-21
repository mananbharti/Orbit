/** Exercises real pinned TLS connections; depends on ws, HTTPS and temporary identities; sends no production commands. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { after, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { MAX_MESSAGE_BYTES } from '../src/config.js';
import type { ResponseMessage } from '../src/protocol/messages.js';
import { createWebSocketTransport } from '../src/transport/websocket/websocket-server.js';
import type { PairingService } from '../src/security-pairing/pairing-service.js';
import { core, testIdentity } from './helpers.js';

const identity = await testIdentity();
after(() => identity.cleanup());

function pinnedTls(fingerprint = identity.channel.certificateFingerprint) {
  return { ca: identity.channel.tls.cert, rejectUnauthorized: true,
    checkServerIdentity: (hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) => {
      const identityError = checkServerIdentity(hostname, certificate);
      if (identityError) return identityError;
      return createHash('sha256').update(certificate.raw).digest('hex') === fingerprint
        ? undefined : new Error('Certificate pin mismatch');
    } };
}

async function fixture(t: TestContext, options: { ttlMs?: number; heartbeatMs?: number } = {}) {
  const context = core(options);
  let executions = 0;
  context.registry.register('test.echo', { validate: () => true,
    execute: async payload => { executions++; return payload; } });
  const transport = createWebSocketTransport({ host: '127.0.0.1', port: 0, tls: identity.channel.tls,
    ...context, heartbeatMs: options.heartbeatMs });
  const address = await transport.start();
  t.after(() => transport.stop());
  const base = `https://127.0.0.1:${address.port}`;
  async function exchange(credential = context.credential, origin?: string) {
    return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(`${base}/v1/session`, { ...pinnedTls(), method: 'POST', agent: false,
        headers: { Authorization: `Bearer ${credential}`, ...(origin ? { Origin: origin } : {}) } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) as Record<string, unknown> }));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }
  function connect(token: string, extra: { fingerprint?: string; autoPong?: boolean } = {}) {
    const socket = new WebSocket(base.replace('https:', 'wss:') + '/v1/channel', {
      ...pinnedTls(extra.fingerprint), headers: { Authorization: `Bearer ${token}` }, autoPong: extra.autoPong });
    // Tests explicitly await error cases; this also prevents cleanup races from becoming uncaught events.
    socket.on('error', () => {});
    return socket;
  }
  return { ...context, exchange, connect, transport, base, executions: () => executions };
}

async function send(socket: WebSocket, type = 'test.echo', payload: unknown = null, requestId = randomUUID()): Promise<ResponseMessage> {
  const received = once(socket, 'message');
  socket.send(JSON.stringify({ version: 1, type, requestId, payload }));
  const [data] = await received;
  return JSON.parse(String(data)) as ResponseMessage;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 15_000; // generous ceiling for loaded CI runners
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for server state');
    await delay(10);
  }
}

test('pinned WSS dispatches commands and never logs credentials or payloads', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const issued = await context.exchange();
  assert.equal(issued.status, 200);
  const socket = context.connect(String(issued.body.sessionToken));
  await once(socket, 'open');
  const response = await send(socket, 'test.echo', 'sensitive clipboard text');
  assert.deepEqual(response.payload, { ok: true, result: 'sensitive clipboard text' });
  const logs = JSON.stringify(context.log.snapshot());
  for (const secret of [context.credential, String(issued.body.sessionToken), 'sensitive clipboard text']) {
    assert.ok(!logs.includes(secret));
  }
});

test('a server fault (503) never burns the caller failure budget', { timeout: 10_000 }, async t => {
  const context = core();
  const transport = createWebSocketTransport({ host: '127.0.0.1', port: 0, tls: identity.channel.tls, ...context,
    pairing: { redeem: () => { throw new Error('pairing store exploded'); } } as unknown as PairingService });
  const address = await transport.start();
  t.after(() => transport.stop());
  const base = `https://127.0.0.1:${address.port}`;
  const call = (path: string, credential?: string) => new Promise<number>((resolve, reject) => {
    const req = request(`${base}${path}`, { ...pinnedTls(), method: 'POST', agent: false,
      ...(credential ? { headers: { Authorization: `Bearer ${credential}` } } : {}) }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
  for (let i = 0; i < 25; i++) assert.equal(await call('/v1/pair'), 503, `fault ${i}`);
  assert.equal(await call('/v1/session', context.credential), 200, 'the address is not punished for server faults');
});

test('unpaired credentials, durable credentials as session tokens, and browser origins are rejected', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  assert.equal((await context.exchange(randomBytes(32).toString('base64url'))).status, 401);
  assert.equal((await context.exchange(context.credential, 'https://example.invalid')).status, 403);
  for (const token of ['', context.credential]) {
    const socket = context.connect(token);
    const [error] = await once(socket, 'error');
    assert.match(String(error), /401/);
  }
  assert.equal(context.executions(), 0);
});

test('session requests carrying a body or chunked encoding are rejected as invalid', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const post = (headers: Record<string, string>, body?: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(`${context.base}/v1/session`, { ...pinnedTls(), method: 'POST', agent: false, headers }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) as Record<string, unknown> }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
  const credential = randomBytes(32).toString('base64url');
  const withLength = await post({ Authorization: `Bearer ${credential}`, 'Content-Length': '5' }, 'hello');
  assert.equal(withLength.status, 400);
  assert.equal(withLength.body.error, 'INVALID_REQUEST');
  const chunked = await post({ Authorization: `Bearer ${credential}`, 'Transfer-Encoding': 'chunked' }, '5\r\nhello\r\n0\r\n\r\n');
  assert.equal(chunked.status, 400);
  assert.equal(chunked.body.error, 'INVALID_REQUEST');
});

test('twenty failed credential guesses lock the address out, even for the real credential', { timeout: 15_000 }, async t => {
  const context = await fixture(t);
  const wrong = randomBytes(32).toString('base64url');
  for (let i = 0; i < 20; i++) assert.equal((await context.exchange(wrong)).status, 401, `guess ${i}`);
  assert.equal((await context.exchange(wrong)).status, 403, 'guess 21 hits the failure lockout');
  assert.equal((await context.exchange()).status, 403, 'even the valid credential is refused until the window passes');
});

test('a wrong certificate pin rejects the connection', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken), { fingerprint: '0'.repeat(64) });
  const [error] = await once(socket, 'error');
  assert.match(String(error), /pin mismatch/);
  assert.equal(context.executions(), 0);
});

test('cleartext WebSocket has no fallback listener', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const socket = new WebSocket(context.base.replace('https:', 'ws:') + '/v1/channel');
  socket.on('error', () => {});
  await once(socket, 'error');
  assert.equal(context.executions(), 0);
});

test('malformed and binary messages fail safely and the next valid command succeeds', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken));
  await once(socket, 'open');
  for (const data of ['{', Buffer.from('binary'), JSON.stringify({ version: 2 })]) {
    const received = once(socket, 'message');
    socket.send(data);
    const [response] = await received;
    assert.equal((JSON.parse(String(response)) as ResponseMessage).payload.ok, false);
  }
  assert.equal((await send(socket)).payload.ok, true);
});

test('oversized messages close only the offending connection', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const token = String(body.sessionToken);
  const socket = context.connect(token);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
  await closed;
  const replacement = context.connect(token);
  await once(replacement, 'open');
  assert.equal((await send(replacement)).payload.ok, true);
});

test('dropped connections are logged and a reconnect does not replay a command', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const token = String(body.sessionToken);
  const socket = context.connect(token);
  await once(socket, 'open');
  const requestId = randomUUID();
  assert.equal((await send(socket, 'test.echo', null, requestId)).payload.ok, true);
  socket.terminate();
  await waitFor(() => context.log.snapshot().some(event => event.eventType === 'connection.closed'));
  const replacement = context.connect(token);
  await once(replacement, 'open');
  assert.deepEqual((await send(replacement, 'test.echo', null, requestId)).payload,
    { ok: false, error: { code: 'DUPLICATE_REQUEST' } });
  assert.equal((await send(replacement)).payload.ok, true);
  assert.equal(context.executions(), 2);
});

test('expired sessions close open sockets and cannot reconnect', { timeout: 10_000 }, async t => {
  const context = await fixture(t, { ttlMs: 300 });
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken));
  await once(socket, 'open');
  const [code] = await once(socket, 'close');
  assert.equal(code, 4001);
  const replacement = context.connect(String(body.sessionToken));
  const [error] = await once(replacement, 'error');
  assert.match(String(error), /401/);
});

test('session renewal authenticates a replacement socket without another QR scan', { timeout: 10_000 }, async t => {
  const context = await fixture(t, { ttlMs: 1_000 });
  const first = await context.exchange();
  const socket = context.connect(String(first.body.sessionToken));
  await once(socket, 'open');
  await delay(550);
  const second = await context.exchange();
  assert.notEqual(second.body.sessionToken, first.body.sessionToken);
  socket.terminate();
  const replacement = context.connect(String(second.body.sessionToken));
  await once(replacement, 'open');
  await delay(500);
  assert.equal(context.auth.authenticate(String(first.body.sessionToken)), undefined);
  assert.equal((await send(replacement)).payload.ok, true);
});

test('payload session tokens cannot change the authenticated device identity', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const first = await context.exchange();
  const second = await context.exchange(context.addDevice().credential);
  const socket = context.connect(String(first.body.sessionToken));
  await once(socket, 'open');
  assert.deepEqual((await send(socket, 'session.refresh', { sessionToken: second.body.sessionToken })).payload,
    { ok: false, error: { code: 'UNKNOWN_COMMAND' } });
  assert.equal((await send(socket)).payload.ok, true);
});

test('revoked credentials cannot dispatch over an already-open socket', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken));
  await once(socket, 'open');
  context.revoke();
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ version: 1, type: 'test.echo', requestId: randomUUID(), payload: null }));
  assert.equal((await closed)[0], 4001);
  assert.equal(context.executions(), 0);
});

test('missed heartbeat terminates a dead peer while the service remains available', { timeout: 10_000 }, async t => {
  const context = await fixture(t, { heartbeatMs: 50 });
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken), { autoPong: false });
  await once(socket, 'open');
  await once(socket, 'close');
  assert.ok(context.log.snapshot().some(event => event.eventType === 'connection.timeout'));
  const replacement = context.connect(String(body.sessionToken));
  await once(replacement, 'open');
  assert.equal((await send(replacement)).payload.ok, true);
});

test('busy sockets cannot create unbounded handler work', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  let finish!: () => void;
  context.registry.register('test.slow', { validate: () => true,
    execute: async () => { await new Promise<void>(resolve => { finish = resolve; }); return null; } });
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken));
  await once(socket, 'open');
  socket.send(JSON.stringify({ version: 1, type: 'test.slow', requestId: randomUUID(), payload: null }));
  await waitFor(() => finish !== undefined);
  assert.deepEqual((await send(socket)).payload, { ok: false, error: { code: 'BUSY' } });
  const completed = once(socket, 'message');
  finish();
  await completed;
  assert.equal((await send(socket)).payload.ok, true);
});

test('desktop events reach only the addressed live device and exclude payloads from the log', { timeout: 10_000 }, async t => {
  const context = await fixture(t);
  const { body } = await context.exchange();
  const socket = context.connect(String(body.sessionToken));
  await once(socket, 'open');
  const messages: unknown[] = [];
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  context.transport.publish(randomUUID(), 'test.changed', 'wrong device');
  const received = once(socket, 'message');
  context.transport.publish(context.deviceId, 'test.changed', 'event secret');
  await received;
  assert.deepEqual(messages, [{ version: 1, type: 'event', requestId: null,
    payload: { eventType: 'test.changed', data: 'event secret' } }]);
  assert.doesNotMatch(JSON.stringify(context.log.snapshot()), /event secret|wrong device/);
  context.revoke();
  const closed = once(socket, 'close');
  context.transport.publish(context.deviceId, 'test.changed', 'revoked secret');
  assert.equal((await closed)[0], 4001);
  assert.equal(messages.length, 1);
});
