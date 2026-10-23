/** Kernel-level smoke for the Wayland helper: creates a real virtual device through /dev/uinput, checks the
 *  kernel-advertised capabilities in sysfs, confirms event writes are accepted, and verifies clean teardown.
 *  Runs only where /dev/uinput is writable (CI enables it with modprobe + chmod); skips elsewhere honestly.
 *  Still not a compositor test: whether GNOME/KDE move the pointer stays a real-device item in docs/TESTING.md. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { HELPER_SCRIPT } from '../src/os-integration/input-device.wayland.js';

function uinputWritable(): boolean {
  try { const fd = openSync('/dev/uinput', 'w'); closeSync(fd); return true; } catch { return false; }
}
const available = process.platform === 'linux' && uinputWritable()
  && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

const DEVICE_NAME = 'Orbit Virtual Input';

function eventNodes(): string[] {
  try { return readdirSync('/sys/class/input').filter(e => e.startsWith('event')); } catch { return []; }
}
function nodeNamed(name: string): string | undefined {
  return eventNodes().find(e => {
    try { return readFileSync(`/sys/class/input/${e}/device/name`, 'utf8').trim() === name; } catch { return false; }
  });
}
/** evdev capability bitmaps are space-separated hex words, most significant word first. */
function capabilityBit(path: string, bit: number): boolean {
  const words = readFileSync(path, 'utf8').trim().split(/\s+/).map(w => BigInt(`0x${w}`));
  const index = words.length - 1 - (bit >> 6);
  if (index < 0) return false;
  return ((words[index]! >> BigInt(bit & 63)) & 1n) === 1n;
}

test('the helper creates a real uinput device with keyboard, button and wheel capabilities', { skip: !available }, async t => {
  const child = spawn('python3', ['-c', HELPER_SCRIPT], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
  t.after(() => { child.kill(); });

  let node: string | undefined;
  for (let i = 0; i < 100 && !node; i++) { node = nodeNamed(DEVICE_NAME); if (!node) await delay(100); }
  assert.ok(node, `the kernel never advertised a device named "${DEVICE_NAME}"; helper stderr: ${stderr}`);

  const rel = (bit: number) => capabilityBit(`/sys/class/input/${node}/device/capabilities/rel`, bit);
  assert.ok(rel(0x00) && rel(0x01), 'REL_X and REL_Y advertised');
  assert.ok(rel(0x06) && rel(0x08), 'REL_HWHEEL and REL_WHEEL advertised - scroll cannot be dropped by the kernel');
  const key = (bit: number) => capabilityBit(`/sys/class/input/${node}/device/capabilities/key`, bit);
  assert.ok(key(28), 'KEY_ENTER advertised');
  assert.ok(key(46), 'KEY_C advertised');
  assert.ok(key(88), 'KEY_F12 advertised');
  assert.ok(key(0x110) && key(0x111) && key(0x112), 'mouse buttons advertised');

  child.stdin.write(JSON.stringify({ t: 'scroll', dx: 0, dy: 30 }) + '\n');
  child.stdin.write(JSON.stringify({ t: 'key', codes: [29, 46], action: 'click' }) + '\n');
  child.stdin.write(JSON.stringify({ t: 'move', dx: 5, dy: -2 }) + '\n');
  child.stdin.end(JSON.stringify({ t: 'stop' }) + '\n');
  const exitCode = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  assert.equal(exitCode, 0, `event writes must be accepted; helper stderr: ${stderr}`);
  assert.equal(stderr.trim(), '', 'the helper never prints diagnostics containing event content');

  for (let i = 0; i < 50 && nodeNamed(DEVICE_NAME); i++) await delay(100);
  assert.equal(nodeNamed(DEVICE_NAME), undefined, 'UI_DEV_DESTROY removed the device on exit');
  assert.ok(existsSync('/dev/uinput'), 'sanity: the kernel device is still there for the next run');
});
