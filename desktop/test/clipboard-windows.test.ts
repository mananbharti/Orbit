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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const within = async (promise: Promise<unknown>, ms: number): Promise<'rejected' | 'resolved' | 'hung'> =>
  Promise.race([promise.then(() => 'resolved' as const, () => 'rejected' as const), sleep(ms).then(() => 'hung' as const)]);

test('a worker that has been replaced cannot disturb the one serving the current request', async () => {
  let attempts = 0;
  const { clip, workers } = clipboard(() => { attempts += 1; return attempts === 1 ? null : attempts === 2 ? null : null; }, 40);
  await assert.rejects(clip.read(), ClipboardUnavailable);
  const second = clip.read();
  await sleep(5);
  const [old, current] = workers as [FakeWorker, FakeWorker];
  old.emit('exit'); old.emit('error', new Error('late')); old.stdin.emit('error', new Error('late')); old.stdout.emit('data', 'garbage\n');
  assert.equal(current.killed, false, 'events from the old worker do not kill the new one');
  current.stdout.emit('data', '{"kind":"text","text":"fine"}\n');
  assert.deepEqual(await second, { kind: 'text', text: 'fine' });
});

test('a response split across chunks is assembled, and anything after it fails the request', async () => {
  const { clip, workers } = clipboard(() => null);
  const pending = clip.read();
  workers[0]!.stdout.emit('data', '{"kind":"te');
  workers[0]!.stdout.emit('data', 'xt","text":"split"}\n');
  assert.deepEqual(await pending, { kind: 'text', text: 'split' });
  const extra = clipboard(() => null);
  const p2 = extra.clip.read();
  extra.workers[0]!.stdout.emit('data', '{"kind":"text","text":"a"}\nsmuggled');
  await assert.rejects(p2, ClipboardUnavailable);
  assert.equal(extra.workers[0]!.killed, true);
});

test('an unsolicited line with no request waiting kills the worker without throwing', async () => {
  const { clip, workers } = clipboard(() => JSON.stringify({ kind: 'text', text: 'one' }));
  await clip.read();
  assert.doesNotThrow(() => workers[0]!.stdout.emit('data', '{"kind":"text","text":"surprise"}\n'));
  assert.equal(workers[0]!.killed, true);
});

test('a finished request cancels its timeout, and whitespace left after a response does not poison the next one', async () => {
  const { clip, workers } = clipboard(() => JSON.stringify({ kind: 'text', text: 'ok' }), 40);
  await clip.read();
  await sleep(90);
  assert.equal(workers[0]!.killed, false, 'the timeout of a finished request never fires');
  const quiet = clipboard(() => null);
  const first = quiet.clip.read();
  quiet.workers[0]!.stdout.emit('data', '{"kind":"text","text":"a"}\n \n');
  assert.deepEqual(await first, { kind: 'text', text: 'a' });
  const second = quiet.clip.read();
  quiet.workers[0]!.stdout.emit('data', '{"kind":"text","text":"b"}\n');
  assert.deepEqual(await second, { kind: 'text', text: 'b' });
});

test('worker exit, process error and stdin error each fail the pending request promptly', async () => {
  for (const trigger of [(w: FakeWorker) => w.emit('exit'), (w: FakeWorker) => w.emit('error', new Error('spawn')), (w: FakeWorker) => w.stdin.emit('error', new Error('EPIPE'))]) {
    const { clip, workers } = clipboard(() => null, 5_000);
    const pending = clip.read();
    setTimeout(() => trigger(workers[0]!), 10);
    assert.equal(await within(pending, 1_000), 'rejected');
  }
  const { clip } = clipboard(() => null, 5_000);
  await clip.dispose();
  assert.equal(await within(clip.read(), 500), 'rejected', 'a disposed bridge refuses at once instead of waiting on a new worker');
});

test('a failed request leaves no half-read output and no stale timer for the next request', async () => {
  const { clip, workers } = clipboard(() => null, 60);
  const first = clip.read();
  workers[0]!.stdout.emit('data', 'abc');
  await assert.rejects(first, ClipboardUnavailable);
  const second = clip.read();
  workers[1]!.stdout.emit('data', '{"kind":"text","text":"clean"}\n');
  assert.deepEqual(await second, { kind: 'text', text: 'clean' }, 'leftovers from the dead worker were discarded');

  const timed = clipboard(() => null, 200);
  const early = timed.clip.read();
  setTimeout(() => timed.workers[0]!.emit('exit'), 5);
  await assert.rejects(early, ClipboardUnavailable);
  await sleep(120);
  const later = timed.clip.read();
  setTimeout(() => timed.workers[1]!.stdout.emit('data', '{"kind":"text","text":"late"}\n'), 150);
  assert.deepEqual(await later, { kind: 'text', text: 'late' }, 'the first request\'s timer did not fire into the second');
});

test('a text snapshot whose text is not a string, or another kind carrying text, is unavailable rather than quietly unsupported', async () => {
  await assert.rejects(clipboard(() => JSON.stringify({ kind: 'text', text: 123 })).clip.read(), ClipboardUnavailable);
  await assert.rejects(clipboard(() => JSON.stringify({ kind: 'unsupported', text: '\u0000bad' })).clip.read(), ClipboardUnavailable);
});
