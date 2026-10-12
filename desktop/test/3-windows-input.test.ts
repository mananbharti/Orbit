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
