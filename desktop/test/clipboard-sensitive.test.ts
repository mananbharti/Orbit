/** Verifies clipboard copies the owner app marked private never sync, never enter history, and never disturb the shared revision; uses synthetic adapters and workers only. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ClipboardHistory } from '../src/clipboard-sync/clipboard-history.js';
import { ClipboardSync } from '../src/clipboard-sync/clipboard-sync.js';
import type { CommandConnection } from '../src/command-router/command-context.js';
import { LinuxClipboard, type ToolResult } from '../src/os-integration/clipboard.linux.js';
import { WindowsClipboard } from '../src/os-integration/clipboard.windows.js';
import { clipboardHistoryResultSchema, clipboardSubscriptionSchema } from '../src/protocol/clipboard.js';
import type { JsonValue, ResponseMessage } from '../src/protocol/messages.js';
import { core } from './helpers.js';
import { MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';

function success(response: ResponseMessage): JsonValue {
  assert.equal(response.payload.ok, true);
  if (!response.payload.ok) throw new Error('Expected success');
  return response.payload.result;
}

function fixture(t: TestContext) {
  const setup = core();
  const root = mkdtempSync(join(tmpdir(), 'orbit-clipboard-sensitive-'));
  const adapter = new MemoryClipboard();
  const history = new ClipboardHistory(join(root, 'history.json'));
  const sync = new ClipboardSync(setup.registry, () => adapter, setup.log, 10, history);
  t.after(async () => { await sync.stop(); rmSync(root, { recursive: true, force: true }); });
  const issued = setup.auth.issue(setup.credential)!;
  const abort = new AbortController();
  const events: { eventType: string; data: JsonValue }[] = [];
  const binding: CommandConnection = { id: randomUUID(), closed: abort.signal,
    isAuthorized: () => !abort.signal.aborted && !!setup.auth.authenticate(issued.sessionToken),
    publish: (eventType, data) => { if (binding.isAuthorized()) events.push({ eventType, data }); } };
  const command = (type: string, payload: JsonValue) => setup.router.dispatch(
    { version: 1, type, requestId: randomUUID(), payload }, issued.sessionToken, binding);
  return { ...setup, adapter, events, command,
    subscribe: async () => clipboardSubscriptionSchema.parse(success(await command('clipboard.subscribe', {}))) };
}

test('a private-marked copy is never published, never stored, and never false-conflicts the next phone write', async t => {
  const { adapter, command, events, subscribe } = fixture(t);
  const sub = await subscribe();
  adapter.value = { kind: 'sensitive' };
  await new Promise(resolve => setTimeout(resolve, 40)); // several polls observe the private copy
  assert.equal(events.length, 0, 'nothing about a private copy reaches the phone');
  adapter.value = { kind: 'text', text: 'meet at 7' };
  await waitForClipboard(() => events.length === 1);
  assert.deepEqual(events[0]?.data, { ...sub, revision: 1, text: 'meet at 7' }, 'the hidden copy did not bump the revision');
  const written = success(await command('clipboard.write', { subscriptionId: sub.subscriptionId, baseRevision: 1, text: 'from the phone' }));
  assert.deepEqual(written, { status: 'applied', revision: 2 }, 'the phone write after a private copy applies without a false conflict');
  const page = clipboardHistoryResultSchema.parse(success(await command('clipboard.history', {})));
  assert.deepEqual(page.entries.map(entry => entry.text), ['from the phone', 'meet at 7'], 'history holds only the two shared clips');
});

for (const wayland of [true, false]) {
  test(`${wayland ? 'Wayland' : 'X11'} reports a password-manager-tagged copy as sensitive without reading its content`, async () => {
    let contentReads = 0;
    const types = wayland ? 'text/plain;charset=utf-8\nx-kde-passwordManagerHint\n' : 'TARGETS\nUTF8_STRING\nx-kde-passwordManagerHint\n';
    const run = async (_file: string, args: string[]): Promise<ToolResult> => {
      if (args.includes('--list-types') || args.includes('TARGETS')) {
        return { output: Buffer.from(types), code: 0, error: '', overflow: false };
      }
      contentReads++;
      return { output: Buffer.from('must never be read'), code: 0, error: '', overflow: false };
    };
    const adapter = new LinuxClipboard(wayland ? { WAYLAND_DISPLAY: 'wayland-0' } : { DISPLAY: ':0' }, run);
    assert.deepEqual(await adapter.read(), { kind: 'sensitive' });
    assert.equal(contentReads, 0, 'the text target is never requested for a private copy');
  });
}

class SensitiveWorker extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { write: (text: string, enc: string, cb: (e?: Error) => void) => boolean };
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  readonly stderr = { resume() {} } as never;
  constructor() {
    super();
    this.stdout.setEncoding = () => {};
    this.stdin.write = ((text: string, _enc: string, cb: (e?: Error) => void) => {
      cb();
      const request = JSON.parse(text.trim()) as { op: string };
      if (request.op === 'read') queueMicrotask(() => this.stdout.emit('data', `${JSON.stringify({ kind: 'sensitive' })}\n`));
      return true;
    }) as never;
  }
  kill(): void {}
  pid = 1234;
}

test('the Windows bridge passes a worker sensitive snapshot through unchanged', async () => {
  const clip = new WindowsClipboard(() => new SensitiveWorker() as unknown as ChildProcessWithoutNullStreams);
  assert.deepEqual(await clip.read(), { kind: 'sensitive' });
  await clip.dispose();
});

test('the Windows worker script honors the documented private-copy exclusion formats', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'os-integration', 'clipboard.windows.ts'), 'utf8');
  for (const marker of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
    assert.ok(source.includes(marker), `${marker} is missing from the worker script`);
  }
  assert.ok(source.includes("kind = 'sensitive'"), 'the worker script never maps a private copy to the sensitive snapshot');
});
