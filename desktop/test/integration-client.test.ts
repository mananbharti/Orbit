/** Verifies automatic renewal and failure semantics over real pinned WSS; depends on local services; never touches OS input or clipboard. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../src/desktop-service.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';

async function fixture(t: TestContext, ttlMs: number) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-client-'));
  const registry = new CommandRegistry();
  const options = { directory: join(root, 'private'), host: '127.0.0.1', port: 0,
    displayName: 'Orbit Test', discovery: false, sessionTtlMs: ttlMs, registry };
  const service = await startDesktop(options);
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired);
  t.after(async () => { client.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  return { service, client, paired, registry, options };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000) { // generous ceiling for loaded CI runners; the poll keeps passing tests fast
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected client state did not arrive');
    await delay(10);
  }
}

test('automatic renewal uses new connections and keeps feature commands usable without rescanning', async t => {
  const { client, service, registry } = await fixture(t, 400);
  registry.register('test.echo', { validate: () => true, execute: async payload => payload });
  let connections = 0;
  client.on('status', status => { if (status === 'connected') connections++; });
  await client.start();
  assert.equal((await client.command('test.echo', null)).payload.ok, true);
  await waitFor(() => connections >= 3 && client.connected);
  assert.equal((await client.command('test.echo', null)).payload.ok, true);
  assert.equal(service.log.snapshot().filter(event => event.eventType === 'pairing.completed').length, 1);
  assert.ok(service.log.snapshot().filter(event => event.eventType === 'session.issued').length >= 3);
});

test('a throwing desktop-event listener does not drop the connection', async t => {
  const { client, registry } = await fixture(t, 60_000);
  registry.register('test.ping', { validate: () => true, execute: async (_payload, context) => {
    context.connection?.publish('test.event', { hello: 1 });
    return { pong: true };
  } });
  const events: unknown[] = [];
  client.on('desktop-event', () => { throw new Error('listener blew up'); });
  client.on('desktop-event', event => events.push(event));
  await client.start();
  const response = await client.command('test.ping', null);
  assert.equal(response.payload.ok, true, 'the command still completes');
  assert.equal(client.connected, true, 'a local listener bug is not a protocol violation');
  assert.deepEqual(events, [{ eventType: 'test.event', data: { hello: 1 } }], 'later listeners still receive the event');
});

test('renewal interrupts an in-flight command with unknown outcome and never replays it', async t => {
  const { client, registry } = await fixture(t, 400);
  let executions = 0;
  let finish!: () => void;
  registry.register('test.slow', { validate: () => true, execute: async () => {
    executions++;
    await new Promise<void>(resolve => { finish = resolve; });
    return null;
  } });
  await client.start();
  await assert.rejects(client.command('test.slow', null), /outcome is unknown/);
  await waitFor(() => client.connected);
  finish();
  await delay(100);
  assert.equal(executions, 1);
});

test('after a service restart the client reconnects using its durable credential', async t => {
  const { client, service, options, registry } = await fixture(t, 5_000);
  registry.register('test.echo', { validate: () => true, execute: async () => null });
  let connects = 0;
  client.on('status', status => { if (status === 'connected') connects++; });
  await client.start();
  const port = Number(new URL(service.hint.endpoint).port);
  await service.stop();
  const restarted = await startDesktop({ ...options, port });
  try {
    await waitFor(() => connects >= 2 && client.connected);
    assert.equal((await client.command('test.echo', null)).payload.ok, true);
  } finally { client.stop(); await restarted.stop(); }
});

test('stopping cancels reconnection and payload authentication commands are refused locally', async t => {
  const { client, service } = await fixture(t, 300);
  await client.start();
  await assert.rejects(client.command('session.refresh', {}), /Invalid feature command/);
  client.stop();
  const issued = service.log.snapshot().filter(event => event.eventType === 'session.issued').length;
  await delay(450);
  assert.equal(service.log.snapshot().filter(event => event.eventType === 'session.issued').length, issued);
  await assert.rejects(client.command('test.echo', null), /not sent/);
});

test('cancelling during endpoint discovery prevents a later authenticated connection', async t => {
  const { paired, service } = await fixture(t, 5_000);
  const client = new OrbitClient(paired, signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Discovery cancelled')), { once: true });
  }));
  const started = client.start();
  const rejected = assert.rejects(started, /Discovery cancelled/);
  client.stop();
  await rejected;
  assert.equal(service.log.snapshot().filter(event => event.eventType === 'session.issued').length, 0);
  await assert.rejects(client.start(), /already started/);
});
