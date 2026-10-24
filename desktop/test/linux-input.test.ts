/** Verifies the Linux (xdotool/XTEST) input adapter: pure event translation, availability probing, held-button/key release; depends on a fake spawn except the guarded real-X11 suite at the bottom. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LinuxInputDevice, toCommands } from '../src/os-integration/input-device.linux.js';

function fake(exitCode = 0) {
  const children: EventEmitter[] = [];
  const written: string[] = [];
  let stdinEnded = false;
  const stdin = { write: (line: string) => { written.push(line.replace(/\n$/, '')); return true; }, end: () => { stdinEnded = true; setImmediate(() => worker.emit('exit', 0)); } };
  const worker = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  const spawnFn = (_cmd: string, args: string[]) => {
    if (args[0] === '-') { children.push(worker); return worker as unknown as ChildProcessWithoutNullStreams; }
    const probe = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
    children.push(probe);
    setImmediate(() => probe.emit('exit', exitCode));
    return probe as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn, worker: worker as unknown as { killed: boolean }, written, stdinEnded: () => stdinEnded };
}

test('dispose closes stdin and lets the worker drain instead of killing it mid-keystroke (F5-stuck-down regression)', async () => {
  const { spawnFn, worker, stdinEnded } = fake();
  const d = new LinuxInputDevice(spawnFn as never);
  const ac = new AbortController();
  const savedDisplay = process.env.DISPLAY; process.env.DISPLAY = ':99';
  try { await openApplyDispose(); } finally { process.env.DISPLAY = savedDisplay; }
  return;
  async function openApplyDispose() {
  await d.open(ac.signal);
  await d.apply({ t: 'key', key: 'f5' }, ac.signal);
  await d.dispose(); // must not leave a half-applied atomic key behind
  }
  assert.equal(stdinEnded(), true, 'stdin closed so the worker drains queued commands');
  assert.equal(worker.killed, false, 'worker exited cleanly within the drain window - no kill, no stuck key');
});

test('events translate to the right xdotool commands', () => {
  assert.deepEqual(toCommands({ t: 'move', dx: 5, dy: -3 }), [['mousemove_relative', '--', '5', '-3']]);
  assert.deepEqual(toCommands({ t: 'button', button: 'right', action: 'click' }), [['click', '3']]);
  assert.deepEqual(toCommands({ t: 'button', button: 'left', action: 'down' }), [['mousedown', '1']]);
  assert.deepEqual(toCommands({ t: 'scroll', dx: 0, dy: 60 }), [['click', '--repeat', '2', '5']]);
  assert.deepEqual(toCommands({ t: 'scroll', dx: -30, dy: 0 }), [['click', '--repeat', '1', '6']]);
  assert.deepEqual(toCommands({ t: 'scroll', dx: 0, dy: 0 }), []);
  assert.deepEqual(toCommands({ t: 'scroll', dx: 0, dy: 99999 }), [['click', '--repeat', '10', '5']], 'notches capped');
  assert.deepEqual(toCommands({ t: 'key', key: 'v', modifiers: ['ctrl', 'ctrl', 'shift'] }), [['key', 'Control_L+Shift_L+v']]);
  assert.deepEqual(toCommands({ t: 'key', key: 'enter', action: 'down' }), [['keydown', 'Return']]);
  assert.deepEqual(toCommands({ t: 'key', key: 'left', modifiers: ['ctrl'], action: 'up' }), [['keyup', 'Left'], ['keyup', 'Control_L']]);
  assert.deepEqual(toCommands({ t: 'key', key: 'mute' }), [['key', 'XF86AudioMute']]);
  assert.deepEqual(toCommands({ t: 'text', text: 'hi there' }), [['type', '--', 'hi there']]);
  assert.deepEqual(toCommands({ t: 'text', text: '' }), []);
});

test('opens only when xdotool answers, applies events, dies cleanly', async () => {
  const f = fake(); const d = new LinuxInputDevice(f.spawnFn); const ac = new AbortController();
  const savedDisplay = process.env.DISPLAY; process.env.DISPLAY = ':99';
  try {
    await d.open(ac.signal);
    await d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal);
    assert.deepEqual(f.written, ['mousemove_relative -- 1 1']);
    await assert.rejects(() => new LinuxInputDevice(fake(1).spawnFn).open(ac.signal), /INPUT_UNAVAILABLE/, 'non-zero probe = unavailable');
  } finally { process.env.DISPLAY = savedDisplay; }
});

test('open refuses without DISPLAY (Wayland sessions have no XTEST)', async () => {
  const saved = process.env.DISPLAY; delete process.env.DISPLAY;
  try { await assert.rejects(() => new LinuxInputDevice(fake().spawnFn).open(new AbortController().signal), /INPUT_UNAVAILABLE/); }
  finally { if (saved !== undefined) process.env.DISPLAY = saved; }
});

test('releaseAll lifts held buttons and keys in reverse order, and only those', async () => {
  const f = fake(); const d = new LinuxInputDevice(f.spawnFn); const ac = new AbortController();
  const savedDisplay = process.env.DISPLAY; process.env.DISPLAY = ':99';
  try {
    await d.open(ac.signal);
    await d.apply({ t: 'button', button: 'left', action: 'down' }, ac.signal);
    await d.apply({ t: 'key', key: 'c', modifiers: ['ctrl'], action: 'down' }, ac.signal);
    await d.apply({ t: 'button', button: 'right', action: 'click' }, ac.signal);
    f.written.length = 0;
    await d.releaseAll();
    assert.deepEqual(f.written, ['mouseup 1', 'keyup c', 'keyup Control_L']);
    f.written.length = 0;
    await d.releaseAll();
    assert.deepEqual(f.written, [], 'idempotent: nothing held, nothing sent');
    await d.dispose(); assert.equal(f.stdinEnded(), true, 'stdin closed for a clean drain'); assert.equal(f.worker.killed, false, 'worker drained and exited - no kill');
    await assert.rejects(() => d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal), /INPUT_UNAVAILABLE/);
  } finally { process.env.DISPLAY = savedDisplay; }
});

const hasX11 = process.env.ORBIT_TEST_X11 === '1';
test('real X11: pointer, button, key and text land in the X server', { skip: !hasX11, timeout: 30_000 }, async () => {
  const d = new LinuxInputDevice(); const ac = new AbortController();
  await d.open(ac.signal);
  const loc = () => execFileSync('xdotool', ['getmouselocation'], { encoding: 'utf8' });
  const before = loc().match(/x:(\d+) y:(\d+)/)!.slice(1).map(Number);
  execFileSync('xdotool', ['mousemove', '100', '100']);
  await d.apply({ t: 'move', dx: 50, dy: 60 }, ac.signal);
  await new Promise(r => setTimeout(r, 300));
  const after = loc().match(/x:(\d+) y:(\d+)/)!.slice(1).map(Number);
  assert.deepEqual(after, [150, 160], `pointer moved (${before} -> ${after})`);
  await d.apply({ t: 'button', button: 'left', action: 'click' }, ac.signal);
  await d.apply({ t: 'key', key: 'a' }, ac.signal);
  await d.apply({ t: 'text', text: 'Orbit हि' }, ac.signal);
  await d.dispose();
});
