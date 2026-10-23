/** Verifies the Wayland input adapter: pure translation, worker protocol, held-key release, probe honesty, and the
 *  real helper's kernel byte encoding via its self-test mode; uses fake spawns and never touches a real input device. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HELPER_SCRIPT, toWaylandEvents, WaylandInputDevice } from '../src/os-integration/input-device.wayland.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

test('translation maps every event kind, modifier chords and tap default onto helper messages', () => {
  assert.deepEqual(toWaylandEvents({ t: 'move', dx: 12, dy: -5 }), [{ t: 'move', dx: 12, dy: -5 }]);
  assert.deepEqual(toWaylandEvents({ t: 'button', button: 'right', action: 'down' }), [{ t: 'button', button: 'right', action: 'down' }]);
  assert.deepEqual(toWaylandEvents({ t: 'scroll', dx: 0, dy: 90 }), [{ t: 'scroll', dx: 0, dy: 90 }]);
  assert.deepEqual(toWaylandEvents({ t: 'key', key: 'enter' }), [{ t: 'key', codes: [28], action: 'click' }], 'missing action is a tap');
  assert.deepEqual(toWaylandEvents({ t: 'key', key: 'c', modifiers: ['ctrl'], action: 'down' }), [{ t: 'key', codes: [29, 46], action: 'down' }]);
  assert.deepEqual(toWaylandEvents({ t: 'key', key: 'f12', modifiers: ['shift', 'shift'] }), [{ t: 'key', codes: [42, 88], action: 'click' }], 'modifiers dedupe');
  assert.deepEqual(toWaylandEvents({ t: 'text', text: 'hello' }), [{ t: 'text', text: 'hello' }]);
  assert.deepEqual(toWaylandEvents({ t: 'text', text: '' }), [], 'empty text emits nothing');
});

class FakeWorker extends EventEmitter {
  readonly stdin = new EventEmitter() as EventEmitter & { write: (text: string, enc: string, cb?: (e?: Error) => void) => boolean };
  readonly stdout = new EventEmitter() as EventEmitter & { resume: () => void; setEncoding: (e: string) => void };
  readonly stderr = { resume() {} } as never;
  readonly written: string[] = [];
  killed = false;
  constructor(dieImmediately = false, exitSoon = false) {
    super();
    this.stdout.resume = () => {};
    this.stdout.setEncoding = () => {};
    this.stdin.write = ((text: string) => { this.written.push(text); return true; }) as never;
    if (dieImmediately) queueMicrotask(() => this.emit('exit', 1));
    else if (exitSoon) queueMicrotask(() => this.emit('exit', 0)); // one-shot tools such as ydotool finish
  }
  kill(): void { this.killed = true; }
  pid = 1234;
}

// open() requires /dev/uinput write access, which CI and sandboxes do not grant; the access check is the honest
// gate, so adapter behavior tests stub it out through a subclass seam.
class TestDevice extends WaylandInputDevice {
  protected override async checkAccess(): Promise<void> { /* fake worker path skips the device check */ }
}

const device = (dieImmediately = false) => {
  const workers: FakeWorker[] = [];
  const spawnFn = (command: string) => {
    const w = new FakeWorker(dieImmediately && command === 'python3', command === 'ydotool');
    workers.push(w);
    return w as unknown as ChildProcessWithoutNullStreams;
  };
  return { device: new TestDevice(spawnFn), workers };
};

test('a helper that cannot create the device fails closed: no session, no native access', async () => {
  const { device: d } = device(true);
  await assert.rejects(() => d.open(new AbortController().signal), /INPUT_UNAVAILABLE/);
});

test('events stream as JSON lines, text goes to ydotool, and abort releases every held button and key', async () => {
  const { device: d, workers } = device();
  const ac = new AbortController();
  await d.open(ac.signal);
  await d.apply({ t: 'move', dx: 3, dy: 4 }, ac.signal);
  await d.apply({ t: 'button', button: 'left', action: 'down' }, ac.signal);
  await d.apply({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'down' }, ac.signal);
  await d.apply({ t: 'scroll', dx: 0, dy: -30 }, ac.signal);
  const python = workers.find(w => w !== undefined)!;
  assert.deepEqual(python.written.map(line => JSON.parse(line)), [
    { t: 'move', dx: 3, dy: 4 },
    { t: 'button', button: 'left', action: 'down' },
    { t: 'key', codes: [29, 47], action: 'down' },
    { t: 'scroll', dx: 0, dy: -30 },
  ]);
  await d.apply({ t: 'text', text: 'hi' }, ac.signal);
  const typed = python.written.map(line => JSON.parse(line) as { t: string });
  assert.equal(typed.filter(m => m.t === 'text').length, 0, 'text never goes through the helper');
  ac.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  const releases = python.written.map(line => JSON.parse(line) as { t: string; action?: string; button?: string })
    .filter(m => m.action === 'up');
  assert.deepEqual(releases, [
    { t: 'button', button: 'left', action: 'up' },
    { t: 'key', codes: [29, 47], action: 'up' },
  ], 'abort releases the held button and chord');
  assert.ok(python.killed, 'the helper is stopped after release');
  await assert.rejects(() => d.apply({ t: 'move', dx: 1, dy: 1 }, new AbortController().signal), /INPUT_UNAVAILABLE/);
});

test('an unknown key or modifier is rejected, never silently dropped', () => {
  assert.throws(() => toWaylandEvents({ t: 'key', key: 'screenshot' as never }), /INPUT_UNAVAILABLE/);
  assert.throws(() => toWaylandEvents({ t: 'key', key: 'a', modifiers: ['hyper' as never] }), /INPUT_UNAVAILABLE/);
});

test('the embedded helper matches the standalone script people read and run by hand', () => {
  const standalone = readFileSync(join(process.cwd(), 'uinput', 'orbit-input-helper.py'), 'utf8');
  assert.equal(HELPER_SCRIPT.trim(), standalone.trim(), 'uinput/orbit-input-helper.py and the embedded HELPER_SCRIPT drifted');
});

const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

test('the real helper encodes evdev bytes for scroll, buttons and keys exactly', { skip: !hasPython }, async () => {
  const out = join(tmpdir(), `orbit-uinput-test-${randomUUID()}`);
  const child = spawnSync('python3', ['-c', HELPER_SCRIPT], {
    env: { ...process.env, ORBIT_INPUT_TEST_OUT: out },
    input: [
      JSON.stringify({ t: 'scroll', dx: 0, dy: 30 }),
      JSON.stringify({ t: 'button', button: 'left', action: 'click' }),
      JSON.stringify({ t: 'key', codes: [29, 46], action: 'click' }),
      JSON.stringify({ t: 'move', dx: 5, dy: -2 }),
      JSON.stringify({ t: 'stop' }),
    ].join('\n') + '\n',
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr.toString());
  const bytes = readFileSync(out);
  rmSync(out, { force: true });
  const ev = (type: number, code: number, value: number): Buffer => {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(type, 16); b.writeUInt16LE(code, 18); b.writeInt32LE(value, 20);
    return b;
  };
  const SYN = ev(0x00, 0, 0);
  const expected = Buffer.concat([
    ev(0x02, 0x08, -1), SYN, // REL_WHEEL one notch down (dy > 0 = down)
    ev(0x01, 0x110, 1), ev(0x01, 0x110, 0), SYN, // BTN_LEFT click
    ev(0x01, 29, 1), ev(0x01, 46, 1), ev(0x01, 46, 0), ev(0x01, 29, 0), SYN, // ctrl+c click releases reversed
    ev(0x02, 0x00, 5), ev(0x02, 0x01, -2), SYN, // relative move
  ]);
  assert.deepEqual(bytes, expected);
});
