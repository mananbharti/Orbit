/** Verifies the Windows clipboard worker bridge against a fake PowerShell worker: request/response protocol, validation, timeouts, crashes, disposal; depends on no clipboard. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClipboardUnavailable } from '../src/os-integration/clipboard.js';
import { WindowsClipboard } from '../src/os-integration/clipboard.windows.js';
import { MAX_CLIPBOARD_BYTES } from '../src/protocol/clipboard.js';

class FakeWorker extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { write: (text: string, enc: string, cb: (e?: Error) => void) => boolean };
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  readonly stderr = { resume() {} } as never;
  readonly written: string[] = [];
  killed = false;
  constructor(private readonly respond?: (request: { op: string; text?: string }) => string | null) {
    super();
    this.stdin.write = ((text: string, _enc: string, cb: (e?: Error) => void) => {
      this.written.push(text);
      cb();
      const reply = this.respond?.(JSON.parse(text.trim()) as { op: string; text?: string });
      if (reply != null) queueMicrotask(() => this.stdout.emit('data', reply + '\n'));
      return true;
    }) as never;
    this.stdout.setEncoding = () => {};
  }
  kill(): void { this.killed = true; }
  pid = 1234;
}

const clipboard = (respond?: (request: { op: string; text?: string }) => string | null, timeoutMs = 5_000) => {
  const workers: FakeWorker[] = [];
  const clip = new WindowsClipboard(() => { const w = new FakeWorker(respond); workers.push(w); return w as unknown as ChildProcessWithoutNullStreams; }, timeoutMs);
  return { clip, workers };
};

test('read returns text snapshots and validates them client-side', async () => {
  const { clip, workers } = clipboard(req => req.op === 'read' ? JSON.stringify({ kind: 'text', text: 'meet at 7' }) : null);
  assert.deepEqual(await clip.read(), { kind: 'text', text: 'meet at 7' });
  assert.deepEqual(JSON.parse(workers[0]!.written[0]!), { op: 'read' }, 'the worker got one read request');
  await clip.dispose();
});

test('read maps oversized text to unsupported and invalid shapes to unavailable', async () => {
  const huge = clipboard(() => JSON.stringify({ kind: 'text', text: 'x'.repeat(MAX_CLIPBOARD_BYTES + 10) }));
  assert.deepEqual(await huge.clip.read(), { kind: 'unsupported' }, 'oversized text never leaves the desktop as text');
  const weird = clipboard(() => JSON.stringify({ kind: 'mystery' }));
  await assert.rejects(weird.clip.read(), ClipboardUnavailable);
  const error = clipboard(() => '{"unavailable":true}');
  await assert.rejects(error.clip.read(), ClipboardUnavailable);
});

test('write validates before touching the worker and checks the ack', async () => {
  const { clip, workers } = clipboard(req => req.op === 'write' ? JSON.stringify({ written: true }) : null);
  await clip.write('hello clipboard');
  assert.deepEqual(JSON.parse(workers[0]!.written[0]!), { op: 'write', text: 'hello clipboard' });
  await assert.rejects(clip.write('x'.repeat(MAX_CLIPBOARD_BYTES + 10)), ClipboardUnavailable);
  assert.equal(workers[0]!.written.length, 1, 'invalid text never reaches the worker');
  const badAck = clipboard(() => JSON.stringify({ written: false }));
  await assert.rejects(badAck.clip.write('hi'), ClipboardUnavailable);
});

test('only one request is in flight at a time', async () => {
  const worker = new FakeWorker();
  worker.stdin.write = ((_text: string, _enc: string, cb: (e?: Error) => void) => { cb(); return true; }) as never;
  const clip = new WindowsClipboard(() => worker as unknown as ChildProcessWithoutNullStreams);
  const first = clip.read();
  await assert.rejects(clip.read(), ClipboardUnavailable, 'a second request while one is pending is refused');
  worker.stdout.emit('data', JSON.stringify({ kind: 'text', text: 'late' }) + '\n');
  assert.deepEqual(await first, { kind: 'text', text: 'late' });
});

test('a silent worker times out and the bridge recovers for the next request', async () => {
  let attempts = 0;
  const { clip } = clipboard(() => { attempts += 1; return attempts === 1 ? null : JSON.stringify({ kind: 'text', text: 'back' }); }, 40);
  await assert.rejects(clip.read(), ClipboardUnavailable);
  assert.deepEqual(await clip.read(), { kind: 'text', text: 'back' }, 'a fresh worker serves the next request');
});

test('a crashing or garbage-talking worker fails the pending request', async () => {
  const dying = new FakeWorker();
  const clipA = new WindowsClipboard(() => dying as unknown as ChildProcessWithoutNullStreams);
  const pending = clipA.read();
  dying.emit('exit');
  await assert.rejects(pending, ClipboardUnavailable);
  const garbage = clipboard(() => 'this is not json');
  await assert.rejects(garbage.clip.read(), ClipboardUnavailable);
});

test('an oversized response kills the worker and fails the request', async () => {
  const { clip, workers } = clipboard(() => JSON.stringify({ kind: 'text', text: 'y'.repeat(70 * 1_024) }));
  await assert.rejects(clip.read(), ClipboardUnavailable);
  assert.equal(workers[0]!.killed, true, 'the runaway worker is killed');
});

test('dispose rejects pending requests and refuses new ones', async () => {
  const { clip, workers } = clipboard(() => null);
  const pending = clip.read();
  await clip.dispose();
  await assert.rejects(pending, ClipboardUnavailable);
  await assert.rejects(clip.read(), ClipboardUnavailable);
  assert.equal(workers[0]!.killed, true);
});
