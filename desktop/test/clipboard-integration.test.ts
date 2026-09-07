/** Exercises Clipboard Sync through pairing, pinned WSS and the integration client; depends on synthetic OS adapters; never touches a real clipboard. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../src/desktop-service.js';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { clipboardSubscriptionSchema } from '../src/protocol/clipboard.js';
import { deferred, MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

async function fixture(t: TestContext, ttlMs = 30_000) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-clipboard-'));
  const desktop = new MemoryClipboard();
  const options = { directory: join(root, 'private'), host: '127.0.0.1', port: 0,
    displayName: 'Orbit Clipboard Test', discovery: false, sessionTtlMs: ttlMs,
    clipboard: { createAdapter: () => desktop, pollMs: 10 } };
  const service = await startDesktop(options);
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired);
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    client.stop();
    for (const cleanup of cleanups) await cleanup();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { desktop, service, client, paired, options, cleanups };
}

test('real WSS isolates subscriptions within a paired device and requires fresh subscription after reconnect', async t => {
  const { desktop, client, paired, cleanups } = await fixture(t);
  const other = new OrbitClient(paired);
  cleanups.push(async () => other.stop());
  const events: unknown[] = [];
  const otherEvents: unknown[] = [];
  client.on('desktop-event', event => events.push(event));
  other.on('desktop-event', event => otherEvents.push(event));
  await client.start();
  await other.start();
  assert.equal(desktop.reads, 0);
  const response = await client.command('clipboard.subscribe', {});
  assert.ok(response.payload.ok);
  const subscription = clipboardSubscriptionSchema.parse(response.payload.result);
  await delay(40);
  assert.equal(events.length, 0);
  desktop.value = { kind: 'text', text: 'desktop event on subscribed socket only' };
  await waitForClipboard(() => events.length === 1);
  assert.equal(otherEvents.length, 0);
  const denied = await other.command('clipboard.write', { subscriptionId: subscription.subscriptionId, baseRevision: 1, text: 'stolen' });
  assert.deepEqual(denied.payload, { ok: false, error: { code: 'CLIPBOARD_NOT_SUBSCRIBED' } });
  client.stop();
  await delay(30);
  desktop.value = { kind: 'text', text: 'offline content is not replayed' };
  const reconnect = new OrbitClient(paired);
  cleanups.push(async () => reconnect.stop());
  const later: unknown[] = [];
  reconnect.on('desktop-event', event => later.push(event));
  await reconnect.start();
  assert.deepEqual((await reconnect.command('clipboard.write', { subscriptionId: subscription.subscriptionId,
    baseRevision: 1, text: 'old subscription' })).payload, { ok: false, error: { code: 'CLIPBOARD_NOT_SUBSCRIBED' } });
  assert.equal((await reconnect.command('clipboard.subscribe', {})).payload.ok, true);
  await delay(40);
  assert.equal(later.length, 0);
  assert.equal(desktop.writes.length, 0);
});

test('integration client syncs both directions without initial replay or echo loops and survives renewal', async t => {
  const { desktop, service, client, cleanups } = await fixture(t, 1_500);
  const local = new MemoryClipboard();
  local.value = { kind: 'text', text: 'different local baseline' };
  const bridge = new ClipboardClient(client, local, 10);
  cleanups.push(() => bridge.stop());
  const statuses: string[] = [];
  bridge.on('status', status => statuses.push(status));
  await client.start();
  await waitForClipboard(() => statuses.includes('active'));
  assert.equal(desktop.writes.length + local.writes.length, 0);
  local.value = { kind: 'text', text: 'client to desktop 雪😀\n\t' };
  await waitForClipboard(() => desktop.writes.length === 1);
  assert.deepEqual(desktop.value, local.value);
  desktop.value = { kind: 'text', text: 'desktop to client\r\n' };
  await waitForClipboard(() => local.writes.length === 1);
  assert.deepEqual(local.value, desktop.value);
  await waitForClipboard(() => statuses.filter(status => status === 'active').length >= 2);
  await delay(40);
  assert.equal(desktop.writes.length, 1);
  assert.equal(local.writes.length, 1);
  local.value = { kind: 'text', text: '' };
  await waitForClipboard(() => desktop.writes.length === 2);
  assert.deepEqual(desktop.value, { kind: 'text', text: '' });
  const serialized = JSON.stringify(service.log.snapshot());
  assert.equal(serialized.includes('client to desktop'), false);
  assert.equal(serialized.includes('desktop to client'), false);
  assert.equal(service.log.snapshot().filter(event => event.eventType === 'pairing.completed').length, 1);
});

test('client rejects a stale local copy without rebasing it, then accepts a new copy', async t => {
  const { desktop, client, cleanups } = await fixture(t);
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(client, local, 10);
  cleanups.push(() => bridge.stop());
  const statuses: string[] = [];
  bridge.on('status', status => statuses.push(status));
  await client.start();
  await waitForClipboard(() => statuses.includes('active'));
  const entered = deferred();
  const release = deferred();
  local.beforeRead = async () => { entered.resolve(); await release.promise; };
  await entered.promise;
  local.value = { kind: 'text', text: 'concurrent client text' };
  desktop.value = { kind: 'text', text: 'concurrent desktop text' };
  await delay(35);
  release.resolve();
  local.beforeRead = undefined;
  await waitForClipboard(() => statuses.includes('conflict'));
  await delay(40);
  assert.equal(desktop.writes.length + local.writes.length, 0);
  assert.deepEqual(local.value, { kind: 'text', text: 'concurrent client text' });
  local.value = { kind: 'text', text: 'fresh copy after conflict' };
  await waitForClipboard(() => desktop.writes.length === 1);
  assert.deepEqual(desktop.value, local.value);
});

test('disconnect discards offline changes and resubscription after service restart does not replay either clipboard', async t => {
  const { desktop, service, client, options, cleanups } = await fixture(t);
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(client, local, 10);
  cleanups.push(() => bridge.stop());
  const statuses: string[] = [];
  bridge.on('status', status => statuses.push(status));
  await client.start();
  await waitForClipboard(() => statuses.includes('active'));
  await service.stop();
  await waitForClipboard(() => statuses.includes('disconnected'));
  local.value = { kind: 'text', text: 'client changed while offline' };
  const replacement = new MemoryClipboard();
  replacement.value = { kind: 'text', text: 'desktop changed while offline' };
  const restarted = await startDesktop({ ...options, port: Number(new URL(service.hint.endpoint).port),
    clipboard: { createAdapter: () => replacement, pollMs: 10 } });
  cleanups.push(() => restarted.stop());
  await waitForClipboard(() => statuses.filter(status => status === 'active').length === 2);
  await delay(45);
  assert.equal(desktop.writes.length + replacement.writes.length + local.writes.length, 0);
  replacement.value = { kind: 'text', text: 'fresh desktop copy after restart' };
  await waitForClipboard(() => local.writes.length === 1);
  assert.deepEqual(local.value, replacement.value);
});

test('client stop during a delayed read prevents a pending desktop event from writing the local OS', async t => {
  const { desktop, client, cleanups } = await fixture(t);
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(client, local, 10);
  cleanups.push(() => bridge.stop());
  let active = false;
  bridge.on('status', status => { if (status === 'active') active = true; });
  await client.start();
  await waitForClipboard(() => active);
  const entered = deferred();
  const release = deferred();
  local.beforeRead = async () => { entered.resolve(); await release.promise; };
  await entered.promise;
  desktop.value = { kind: 'text', text: 'must not apply after disconnect' };
  await delay(30);
  client.stop();
  release.resolve();
  await bridge.stop();
  assert.equal(local.writes.length, 0);
});
