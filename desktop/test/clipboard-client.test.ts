/** Tests client cleanup and event ordering with controlled channel acknowledgements; depends on synthetic fixtures; never accesses a native clipboard or network. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import { failure, success, type JsonValue, type ResponseMessage } from '../src/protocol/messages.js';
import type { ErrorCode } from '../src/protocol/errors.js';
import { deferred, MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

class Channel extends EventEmitter {
  connected = true;
  subscribed = false;
  subscriptionId = randomUUID();
  subscribeGate?: ReturnType<typeof deferred>;
  writeGate?: ReturnType<typeof deferred>;
  unsubscribeError?: ErrorCode;
  commands: string[] = [];
  async command(type: string, _payload: JsonValue): Promise<ResponseMessage> {
    this.commands.push(type);
    if (type === 'clipboard.subscribe') {
      this.subscribed = true;
      await this.subscribeGate?.promise;
      return success(randomUUID(), { subscriptionId: this.subscriptionId, revision: 0 });
    }
    if (type === 'clipboard.unsubscribe') {
      if (this.unsubscribeError) {
        if (this.unsubscribeError === 'CLIPBOARD_NOT_SUBSCRIBED') this.subscribed = false;
        return failure(randomUUID(), this.unsubscribeError);
      }
      this.subscribed = false;
      return success(randomUUID(), { unsubscribed: true });
    }
    await this.writeGate?.promise;
    return success(randomUUID(), { status: 'applied', revision: 1 });
  }
  stop(): void {
    this.connected = false;
    this.subscribed = false;
    this.subscribeGate?.resolve();
    this.writeGate?.resolve();
    this.emit('status', 'stopped');
  }
}

test('stop closes the channel when a subscription acknowledgement is still in flight', async t => {
  const channel = new Channel();
  channel.subscribeGate = deferred();
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(channel, local, 10);
  t.after(async () => { channel.stop(); await bridge.stop(); });
  await waitForClipboard(() => channel.subscribed);
  const stopped = bridge.stop();
  assert.equal(channel.connected, false);
  await stopped;
  assert.equal(channel.subscribed, false);
  assert.equal(local.disposed, true);
  assert.equal(local.writes.length, 0);
});

test('adapter disposal failure still removes an acknowledged subscription', async t => {
  const channel = new Channel();
  class FailingDispose extends MemoryClipboard {
    override async dispose(): Promise<void> { this.disposed = true; throw new Error('synthetic disposal failure'); }
  }
  const bridge = new ClipboardClient(channel, new FailingDispose(), 10);
  t.after(() => channel.stop());
  let active = false;
  bridge.on('status', status => { if (status === 'active') active = true; });
  await waitForClipboard(() => active);
  await assert.rejects(bridge.stop(), /synthetic disposal failure/);
  assert.equal(channel.subscribed, false);
  assert.equal(channel.connected, true);
});

test('rejected unsubscribe closes the channel to prevent a lingering subscription', async t => {
  const channel = new Channel();
  channel.unsubscribeError = 'BUSY';
  const bridge = new ClipboardClient(channel, new MemoryClipboard(), 10);
  t.after(async () => { channel.stop(); await bridge.stop(); });
  let active = false;
  bridge.on('status', status => { if (status === 'active') active = true; });
  await waitForClipboard(() => active);
  await bridge.stop();
  assert.equal(channel.connected, false);
  assert.equal(channel.subscribed, false);
});

test('a newer unsupported revision supersedes queued text; old subscriptions and older events cannot write', async t => {
  const channel = new Channel();
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(channel, local, 10);
  t.after(async () => { channel.stop(); await bridge.stop(); });
  let active = false;
  bridge.on('status', status => { if (status === 'active') active = true; });
  await waitForClipboard(() => active);
  const subscriptionId = channel.subscriptionId;
  channel.emit('desktop-event', { eventType: 'clipboard.changed', data: { subscriptionId, revision: 1, text: 'superseded text' } });
  channel.emit('desktop-event', { eventType: 'clipboard.status', data: { subscriptionId, revision: 2, status: 'unsupported' } });
  channel.emit('desktop-event', { eventType: 'clipboard.changed', data: { subscriptionId: randomUUID(), revision: 50, text: 'wrong subscription' } });
  channel.emit('desktop-event', { eventType: 'clipboard.changed', data: { subscriptionId, revision: 1, text: 'old revision' } });
  await delay(35);
  assert.equal(local.writes.length, 0);
  channel.emit('desktop-event', { eventType: 'clipboard.changed', data: { subscriptionId, revision: 3, text: 'current revision' } });
  await waitForClipboard(() => local.writes.length === 1);
  await delay(35);
  assert.deepEqual(local.writes, ['current revision']);
  assert.equal(channel.commands.includes('clipboard.write'), false);
});

test('native read failure disables sync and removes the subscription without retrying stale content', async t => {
  const channel = new Channel();
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(channel, local, 10);
  const statuses: string[] = [];
  bridge.on('status', status => statuses.push(status));
  t.after(async () => { channel.stop(); await bridge.stop(); });
  await waitForClipboard(() => statuses.includes('active'));
  local.failRead = true;
  await waitForClipboard(() => statuses.includes('unavailable'));
  assert.equal(channel.subscribed, false);
  assert.equal(channel.connected, true);
  const reads = local.reads;
  await delay(35);
  assert.equal(local.reads, reads);
  assert.equal(channel.commands.includes('clipboard.write'), false);
});

test('server-side subscription removal disables clipboard polling but leaves the authenticated channel usable', async t => {
  const channel = new Channel();
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(channel, local, 10);
  const statuses: string[] = [];
  bridge.on('status', status => statuses.push(status));
  t.after(async () => { channel.stop(); await bridge.stop(); });
  await waitForClipboard(() => statuses.includes('active'));
  channel.unsubscribeError = 'CLIPBOARD_NOT_SUBSCRIBED';
  channel.emit('desktop-event', { eventType: 'clipboard.status', data: {
    subscriptionId: channel.subscriptionId, revision: 0, status: 'unavailable' } });
  await waitForClipboard(() => !channel.subscribed);
  assert.equal(channel.connected, true);
  assert.ok(statuses.includes('unavailable'));
  assert.equal(local.writes.length, 0);
});

test('stop cancels an in-flight clipboard write without replaying it', async t => {
  const channel = new Channel();
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(channel, local, 10);
  let active = false;
  bridge.on('status', status => { if (status === 'active') active = true; });
  t.after(async () => { channel.stop(); await bridge.stop(); });
  await waitForClipboard(() => active);
  channel.writeGate = deferred();
  local.value = { kind: 'text', text: 'synthetic pending copy' };
  await waitForClipboard(() => channel.commands.includes('clipboard.write'));
  await bridge.stop();
  assert.equal(channel.connected, false);
  assert.equal(channel.subscribed, false);
  assert.equal(channel.commands.filter(command => command === 'clipboard.write').length, 1);
});
