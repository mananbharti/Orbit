/** Unit-pins ClipboardClient revision/reset behaviors with a stub channel; depends on the protocol schemas and MemoryClipboard. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import type { OrbitClient } from '../src/integration-client/orbit-client.js';
import { success, failure } from '../src/protocol/messages.js';
import { MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

function stubChannel(subscriptionId: string, revision: number,
  onWrite?: (payload: { text: string }) => ReturnType<typeof success>) {
  const emitter = new EventEmitter();
  const calls: { type: string; payload: unknown }[] = [];
  const client = Object.assign(emitter, {
    connected: true,
    stop: () => { client.connected = false; },
    scheduledCommand: async (type: string, payload: unknown) => {
      calls.push({ type, payload });
      if (type === 'clipboard.subscribe') return success('r', { subscriptionId, revision } as never);
      if (type === 'clipboard.write') return (onWrite?.(payload as { text: string }) ?? success('r', { status: 'applied', revision: revision + 1 })) as never;
      return success('r', {} as never); // unsubscribe etc.
    },
  });
  return { client: client as unknown as OrbitClient & { connected: boolean }, emitter, calls };
}

const active = (statuses: string[]) => waitForClipboard(() => statuses.includes('active'));

test('a clipboard.status of unavailable disables the bridge and unsubscribes', async () => {
  const subscriptionId = randomUUID();
  const { client, emitter, calls } = stubChannel(subscriptionId, 5);
  const adapter = new MemoryClipboard();
  const statuses: string[] = [];
  const bridge = new ClipboardClient(client, adapter, 5);
  bridge.on('status', s => statuses.push(s));
  await active(statuses);
  emitter.emit('desktop-event', { eventType: 'clipboard.status',
    data: { subscriptionId, revision: 6, status: 'unavailable' } });
  await waitForClipboard(() => statuses.includes('unavailable'));
  assert.ok(calls.some(c => c.type === 'clipboard.unsubscribe'));
  await bridge.stop();
});

test('a replayed clipboard.status with a stale revision is ignored, not re-applied', async () => {
  const subscriptionId = randomUUID();
  const { client, emitter } = stubChannel(subscriptionId, 5);
  const adapter = new MemoryClipboard();
  const statuses: string[] = [];
  const bridge = new ClipboardClient(client, adapter, 5);
  bridge.on('status', s => statuses.push(s));
  await active(statuses);
  const event = { eventType: 'clipboard.status', data: { subscriptionId, revision: 6, status: 'unsupported' } };
  emitter.emit('desktop-event', event);
  await waitForClipboard(() => statuses.includes('unsupported'));
  const seen = statuses.length;
  emitter.emit('desktop-event', event); // exact replay: same revision, already applied
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(statuses.length, seen, 'a stale replay must not re-emit the status');
  await bridge.stop();
});

test('a BUSY write is retried on the next poll, not silently dropped', async () => {
  const subscriptionId = randomUUID();
  let writes = 0;
  const { client } = stubChannel(subscriptionId, 5, () => { writes++; return failure('r', 'BUSY' as never); });
  const adapter = new MemoryClipboard();
  const statuses: string[] = [];
  const bridge = new ClipboardClient(client, adapter, 5);
  bridge.on('status', s => statuses.push(s));
  await active(statuses);
  adapter.value = { kind: 'text', text: 'fresh local copy' };
  await waitForClipboard(() => writes >= 2);
  await bridge.stop();
});
