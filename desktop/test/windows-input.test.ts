import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WindowsInputDevice, toOps } from '../src/os-integration/input-device.windows.js';
import { windowsApproval } from '../src/security-pairing/windows-approval.js';

function fake(reply: (line: string, out: PassThrough) => void, ready = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  const sent: unknown[][] = [];
  child.stdin.on('data', (d: Buffer) => { for (const l of d.toString().split('\n').filter(Boolean)) { sent.push(JSON.parse(l)); reply(l, child.stdout); } });
  if (ready) setImmediate(() => child.stdout.write('{"ready":true}\n'));
  return { child: child as unknown as ChildProcessWithoutNullStreams, raw: child, sent };
}
const ok = (_l: string, out: PassThrough) => out.write('{"ok":true}\n');

test('events translate to the right SendInput operations', () => {
  assert.deepEqual(toOps({ t: 'move', dx: 5, dy: -3 }), [{ k: 'mouse', flags: 1, dx: 5, dy: -3 }]);
  assert.deepEqual(toOps({ t: 'button', button: 'right', action: 'click' }), [{ k: 'mouse', flags: 8 }, { k: 'mouse', flags: 16 }]);
  assert.deepEqual(toOps({ t: 'key', key: 'left', modifiers: ['ctrl', 'ctrl', 'shift'] }), [
    { k: 'key', vk: 17, flags: 0 }, { k: 'key', vk: 16, flags: 0 }, { k: 'key', vk: 0x25, flags: 1 }, { k: 'key', vk: 0x25, flags: 3 }, { k: 'key', vk: 16, flags: 2 }, { k: 'key', vk: 17, flags: 2 }]);
  assert.deepEqual(toOps({ t: 'text', text: 'हि' }).map(o => o.k === 'uni' ? o.scan : 0), [0x939, 0x939, 0x93f, 0x93f]);
  assert.equal(toOps({ t: 'scroll', dx: 0, dy: 0 }).length, 0);
});
test('device opens only when the worker is ready, applies events and reports failure', async () => {
  const f = fake(ok); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  await d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal);
  assert.equal(f.sent.length, 1);
  const bad = fake((_l, out) => out.write('{"ok":false}\n')); const d2 = new WindowsInputDevice(() => bad.child); await d2.open(ac.signal);
  await assert.rejects(() => d2.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal), /INPUT_UNAVAILABLE/);
  const dead = fake(ok, false); dead.raw.stdout.write('garbage\n');
  await assert.rejects(() => new WindowsInputDevice(() => dead.child).open(ac.signal), /INPUT_UNAVAILABLE/);
});
test('releaseAll lifts a held button and key, and only those', async () => {
  const f = fake(ok); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  await d.apply({ t: 'button', button: 'left', action: 'down' }, ac.signal);
  await d.apply({ t: 'button', button: 'right', action: 'click' }, ac.signal);
  await d.releaseAll();
  assert.deepEqual(f.sent.at(-1), [{ k: 'mouse', flags: 4 }]);
  const n = f.sent.length; await d.releaseAll(); assert.equal(f.sent.length, n, 'idempotent: nothing held, nothing sent');
  await d.dispose(); assert.equal((f.raw as unknown as { killed: boolean }).killed, true);
  await assert.rejects(() => d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal), /INPUT_UNAVAILABLE/);
});
test('a hung worker times out as unavailable', { timeout: 15_000 }, async () => {
  const f = fake(() => {}); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  await assert.rejects(() => d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal), /INPUT_UNAVAILABLE/);
});

const ctx = { session: { deviceId: 'abcdef12-0000' } } as never;
const msg = (type: string) => ({ version: 1, type, requestId: 'r', payload: {} }) as never;
test('approval prompt allows only on an explicit ALLOW, denies everything else', async () => {
  const run = async (script: (c: ReturnType<typeof fake>) => void, type = 'input.begin', timeout = 200) => {
    const f = fake(() => {}, false); const p = windowsApproval(() => f.child, timeout).verify(msg(type), ctx); script(f); return p;
  };
  assert.equal(await run(f => f.raw.stdout.write('ALLOW\n')), true);
  assert.equal(await run(f => f.raw.stdout.write('DENY\n')), false);
  assert.equal(await run(f => f.raw.stdout.write('ALLOW and more garbage that is far too long to be an answer from our own script\n')), false);
  assert.equal(await run(() => {}), false, 'timeout denies');
  assert.equal(await run(f => f.raw.emit('error', new Error('x'))), false);
  assert.equal(await run(f => f.raw.stdout.write('ALLOW\n'), 'power.shutdown'), false, 'only approves remote control');
  assert.equal(await windowsApproval(() => { throw new Error('no powershell'); }).verify(msg('input.begin'), ctx), false);
});

test('held chords split into down and up so pointers like the slideshow laser can exist', () => {
  assert.deepEqual(toOps({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'down' }), [
    { k: 'key', vk: 0x11, flags: 0 }, { k: 'key', vk: 0x56, flags: 0 }]);
  assert.deepEqual(toOps({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'up' }), [
    { k: 'key', vk: 0x56, flags: 2 }, { k: 'key', vk: 0x11, flags: 2 }]);
  // a tap is unchanged: full press with release, modifiers out in reverse
  assert.deepEqual(toOps({ t: 'key', key: 'v', modifiers: ['ctrl'] }), [
    { k: 'key', vk: 0x11, flags: 0 }, { k: 'key', vk: 0x56, flags: 0 }, { k: 'key', vk: 0x56, flags: 2 }, { k: 'key', vk: 0x11, flags: 2 }]);
});

test('every key maps to its real Windows virtual-key code, with the extended flag only where Windows needs it', () => {
  const vkOf = (key: string) => (toOps({ t: 'key', key, action: 'down' } as never)[0] as { vk: number; flags: number });
  for (let i = 0; i < 26; i++) assert.deepEqual(vkOf(String.fromCharCode(97 + i)), { k: 'key', vk: 0x41 + i, flags: 0 }, `letter ${i}`);
  for (let i = 0; i < 10; i++) assert.deepEqual(vkOf(String(i)), { k: 'key', vk: 0x30 + i, flags: 0 }, `digit ${i}`);
  for (let i = 1; i <= 12; i++) assert.deepEqual(vkOf(`f${i}`), { k: 'key', vk: 0x6f + i, flags: 0 }, `f${i}`);
  const fixed: Record<string, [number, number]> = { enter: [0x0d, 0], backspace: [0x08, 0], tab: [0x09, 0], escape: [0x1b, 0], space: [0x20, 0],
    delete: [0x2e, 1], up: [0x26, 1], down: [0x28, 1], left: [0x25, 1], right: [0x27, 1], home: [0x24, 1], end: [0x23, 1], pageup: [0x21, 1], pagedown: [0x22, 1],
    volumeup: [0xaf, 0], volumedown: [0xae, 0], mute: [0xad, 0], playpause: [0xb3, 0], next: [0xb0, 0], previous: [0xb1, 0] };
  for (const [key, [vk, flags]] of Object.entries(fixed)) assert.deepEqual(vkOf(key), { k: 'key', vk, flags }, key);
});

test('all four modifiers map to their codes and come out in reverse order', () => {
  const ops = toOps({ t: 'key', key: 'a', modifiers: ['shift', 'ctrl', 'alt', 'meta'] });
  assert.deepEqual(ops.map(o => (o as { vk: number; flags: number }).vk), [0x10, 0x11, 0x12, 0x5b, 0x41, 0x41, 0x5b, 0x12, 0x11, 0x10]);
  assert.deepEqual(ops.map(o => (o as { flags: number }).flags), [0, 0, 0, 0, 0, 2, 2, 2, 2, 2]);
});

test('buttons: down, up and click for left, right and middle use the right flags', () => {
  const flags = (button: string, action?: string) => toOps({ t: 'button', button, ...(action ? { action } : {}) } as never).map(o => (o as { flags: number }).flags);
  assert.deepEqual(flags('left', 'down'), [0x2]); assert.deepEqual(flags('left', 'up'), [0x4]); assert.deepEqual(flags('left', 'click'), [0x2, 0x4]);
  assert.deepEqual(flags('right', 'down'), [0x8]); assert.deepEqual(flags('right', 'up'), [0x10]);
  assert.deepEqual(flags('middle', 'down'), [0x20]); assert.deepEqual(flags('middle', 'up'), [0x40]); assert.deepEqual(flags('middle', 'click'), [0x20, 0x40]);
});

test('scroll sends vertical (inverted) and horizontal wheel ops, scaled, and only for the axes that moved', () => {
  assert.deepEqual(toOps({ t: 'scroll', dx: 0, dy: 3 }), [{ k: 'mouse', flags: 0x800, data: -12 }]);
  assert.deepEqual(toOps({ t: 'scroll', dx: -2, dy: 0 }), [{ k: 'mouse', flags: 0x1000, data: -8 }]);
  assert.deepEqual(toOps({ t: 'scroll', dx: 1, dy: -1 }), [{ k: 'mouse', flags: 0x800, data: 4 }, { k: 'mouse', flags: 0x1000, data: 4 }]);
});

test('text types each UTF-16 unit as a Unicode key down and up', () => {
  assert.deepEqual(toOps({ t: 'text', text: 'a😀' }).map(o => [(o as { scan: number }).scan, (o as { flags: number }).flags]),
    [[0x61, 4], [0x61, 6], [0xd83d, 4], [0xd83d, 6], [0xde00, 4], [0xde00, 6]]);
});

test('held modifiers and keys are released by releaseAll, and a tap leaves nothing held', async () => {
  const f = fake(ok); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  await d.apply({ t: 'key', key: 'a' }, ac.signal);
  await d.releaseAll();
  assert.equal(f.sent.length, 1, 'a full tap holds nothing');
  await d.apply({ t: 'key', key: 'v', modifiers: ['ctrl'], action: 'down' }, ac.signal);
  await d.releaseAll();
  assert.deepEqual(f.sent.at(-1)!.map(o => (o as { vk: number }).vk).sort(), [0x11, 0x56]);
  assert.ok(f.sent.at(-1)!.every(o => (o as { flags: number }).flags === 2));
  await d.apply({ t: 'button', button: 'middle', action: 'down' }, ac.signal);
  await d.apply({ t: 'button', button: 'middle', action: 'up' }, ac.signal);
  const before = f.sent.length; await d.releaseAll();
  assert.equal(f.sent.length, before, 'a released button is no longer held');
});

test('aborting the signal releases what is held and then kills the worker; an aborted signal refuses to open or apply', async () => {
  const f = fake(ok); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  await d.apply({ t: 'button', button: 'left', action: 'down' }, ac.signal);
  ac.abort();
  for (let i = 0; i < 100 && !(f.raw as unknown as { killed: boolean }).killed; i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.sent.at(-1), [{ k: 'mouse', flags: 4 }], 'button lifted before the kill');
  assert.equal((f.raw as unknown as { killed: boolean }).killed, true);
  await assert.rejects(() => d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal), /INPUT_UNAVAILABLE/);
  const dead = new AbortController(); dead.abort();
  let spawned = 0;
  await assert.rejects(() => new WindowsInputDevice(() => { spawned++; return fake(ok).child; }).open(dead.signal), /INPUT_UNAVAILABLE/);
  assert.equal(spawned, 0, 'no worker is started for an aborted signal');
});

test('a worker that dies or floods output fails the pending call instead of hanging', async () => {
  const dying = fake(() => {}); const d = new WindowsInputDevice(() => dying.child); const ac = new AbortController();
  await d.open(ac.signal);
  const pending = d.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal);
  setTimeout(() => dying.raw.emit('exit'), 20);
  const started = Date.now();
  await assert.rejects(pending, /INPUT_UNAVAILABLE/);
  assert.ok(Date.now() - started < 2_000, 'rejected when the worker exited, not at the 5 second timeout');
  const flood = fake(() => {}); const d2 = new WindowsInputDevice(() => flood.child);
  await d2.open(ac.signal);
  const pending2 = d2.apply({ t: 'move', dx: 1, dy: 1 }, ac.signal);
  setTimeout(() => flood.raw.stdout.write('x'.repeat(5000)), 20);
  const outcome = await Promise.race([pending2.then(() => 'resolved', () => 'rejected'), new Promise(r => setTimeout(() => r('hung'), 1500))]);
  assert.notEqual(outcome, 'resolved');
  assert.equal((flood.raw as unknown as { killed: boolean }).killed, true, 'a flooding worker is killed');
});

test('an event whose own signal is already aborted is refused and never reaches a live worker', async () => {
  const f = fake(ok); const d = new WindowsInputDevice(() => f.child); const ac = new AbortController();
  await d.open(ac.signal);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(() => d.apply({ t: 'button', button: 'left', action: 'down' }, cancelled.signal), /INPUT_UNAVAILABLE/);
  assert.equal(f.sent.length, 0);
  await d.releaseAll();
  assert.equal(f.sent.length, 0, 'nothing was tracked as held either');
});
