/** Linux Wayland pointer and keyboard through a virtual uinput device; depends on python3 (standard library only)
 *  and write access to /dev/uinput, with ydotool used only for free-text typing; never logs typed text and releases
 *  every held button and key on abort. Wayland compositors accept kernel-level uinput events from any process with
 *  device access, so setup requires a udev rule (documented in docs/ACCEPTANCE.md); without it the probe fails by design. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { InputEvent } from '../protocol/input.js';
import type { InputDevice } from './input-device.js';

type Spawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;
const defaultSpawn: Spawn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

/** The embedded helper creates one virtual input device and applies JSON events from stdin. Kept in sync with
 *  uinput/orbit-input-helper.py, which exists for the byte-encoding test and for reading outside the bundle. */
export const HELPER_SCRIPT = String.raw`
#!/usr/bin/env python3
"""Orbit Wayland input helper: creates a virtual uinput device and applies JSON events from stdin.

Dependency-free (Python 3 standard library only). Requires write access to /dev/uinput,
which on most distros means a udev rule such as:
    KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"
plus the user in the "input" group, then re-login or run: udevadm trigger

Protocol: one JSON object per line on stdin, fields:
  {"t":"move","dx":int,"dy":int}      relative pointer motion
  {"t":"button","button":"left|middle|right","action":"down|up|click"}
  {"t":"scroll","dx":int,"dy":int}    wheel units; dy>0 scrolls down, dx>0 scrolls right (Orbit convention)
  {"t":"key","codes":[int,...],"action":"down|up|click"}   evdev key codes, press order given, release reversed
  {"t":"stop"}                        exit
Lines that fail to parse are ignored; the helper never prints event content.

Self-test: run with ORBIT_INPUT_TEST_OUT=<path> and no /dev/uinput needed - the exact
event byte stream that would go to the kernel is written to that file instead.
"""
import fcntl
import json
import os
import struct
import sys

# ioctl constants (linux/uinput.h), valid on 32- and 64-bit because the _IOC size field matches here
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN, EV_KEY, EV_REL = 0x00, 0x01, 0x02
SYN_REPORT = 0
REL_X, REL_Y, REL_HWHEEL, REL_WHEEL = 0x00, 0x01, 0x06, 0x08
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
SCROLL_UNITS_PER_NOTCH = 30  # matches the desktop adapters: 30 phone units ~ one wheel notch
MAX_NOTCHES = 10

EVENT = struct.Struct("llHHi")  # struct input_event on 64-bit: timeval(2 x long), __u16 type, __u16 code, __s32 value


def user_dev_struct(name: bytes) -> bytes:
    """struct uinput_user_dev: char name[80]; struct input_id{4 x __u16}; __u32 ff_effects_max;
    __s32 absmax[64]; absmin[64]; absfuzz[64]; absflat[64]."""
    name = name[:79].ljust(80, b"\0")
    input_id = struct.pack("HHHH", 0x03, 0x0F31, 0x0001, 0x0001)  # BUS_USB, Orbit vendor, product, version
    return name + input_id + struct.pack("I", 0) + (struct.pack("i", 0) * 64 * 4)


class VirtualInput:
    def __init__(self, test_out: str | None):
        self.test_file = open(test_out, "wb") if test_out else None
        self.fd: int | None = None
        if self.test_file:
            return
        self.fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        for bit in (EV_KEY, EV_REL):
            fcntl.ioctl(self.fd, UI_SET_EVBIT, bit)
        for code in (REL_X, REL_Y, REL_HWHEEL, REL_WHEEL):
            fcntl.ioctl(self.fd, UI_SET_RELBIT, code)
        for code in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        os.write(self.fd, user_dev_struct(b"Orbit Virtual Input"))
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def emit(self, etype: int, code: int, value: int) -> None:
        data = EVENT.pack(0, 0, etype, code, value)
        if self.test_file:
            self.test_file.write(data)
        else:
            os.write(self.fd, data)  # type: ignore[arg-type]

    def sync(self) -> None:
        self.emit(EV_SYN, SYN_REPORT, 0)

    def close(self) -> None:
        if self.test_file:
            self.test_file.close()
            return
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(self.fd)


def notches(units: int) -> int:
    if not units:
        return 0
    return max(1, min(MAX_NOTCHES, round(abs(units) / SCROLL_UNITS_PER_NOTCH)))


def apply(dev: VirtualInput, event: dict) -> None:
    t = event.get("t")
    if t == "move":
        dx, dy = int(event.get("dx", 0)), int(event.get("dy", 0))
        if dx:
            dev.emit(EV_REL, REL_X, dx)
        if dy:
            dev.emit(EV_REL, REL_Y, dy)
        dev.sync()
    elif t == "button":
        code = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}.get(event.get("button", "left"), BTN_LEFT)
        action = event.get("action", "click")
        if action in ("down", "click"):
            dev.emit(EV_KEY, code, 1)
        if action in ("up", "click"):
            dev.emit(EV_KEY, code, 0)
        dev.sync()
    elif t == "scroll":
        dy, dx = int(event.get("dy", 0)), int(event.get("dx", 0))
        if dy:  # dy > 0 scrolls down; REL_WHEEL is negative downward in evdev
            dev.emit(EV_REL, REL_WHEEL, -1 if dy > 0 else 1)
        if dx:  # dx > 0 scrolls right; REL_HWHEEL is positive rightward
            dev.emit(EV_REL, REL_HWHEEL, 1 if dx > 0 else -1)
        dev.sync()
    elif t == "key":
        codes = [int(c) for c in event.get("codes", [])]
        action = event.get("action", "click")
        if action in ("down", "click"):
            for c in codes:
                dev.emit(EV_KEY, c, 1)
        if action in ("up", "click"):
            for c in reversed(codes):
                dev.emit(EV_KEY, c, 0)
        dev.sync()


def main() -> None:
    dev = VirtualInput(os.environ.get("ORBIT_INPUT_TEST_OUT") or None)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("t") == "stop":
                break
            if event.get("t") == "scroll":  # expand units into notches, one event set per notch
                n = notches(int(event.get("dy", 0)) or int(event.get("dx", 0)))
                for _ in range(n):
                    apply(dev, event)
            else:
                apply(dev, event)
    finally:
        dev.close()


if __name__ == "__main__":
    main()

`;

// evdev key codes (linux/input-event-codes.h) for every key the phone UI and macros can send
const KEY: Record<string, number> = { enter: 28, backspace: 14, delete: 111, tab: 15, escape: 1, space: 57,
  up: 103, down: 108, left: 105, right: 106, home: 102, end: 107, pageup: 104, pagedown: 109,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  volumeup: 115, volumedown: 114, mute: 113, playpause: 164, next: 163, previous: 165,
  a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50, n: 49, o: 24,
  p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10, '0': 11 };
const MOD: Record<string, number> = { shift: 42, ctrl: 29, alt: 56, meta: 125 };

export interface WaylandInputEvent { t: string; dx?: number; dy?: number; button?: string; action?: string;
  codes?: number[]; text?: string }

/** Pure translation of one event into helper JSON messages; 'text' events stay marked for the ydotool path. */
export function toWaylandEvents(event: InputEvent): WaylandInputEvent[] {
  switch (event.t) {
    case 'move': return [{ t: 'move', dx: event.dx, dy: event.dy }];
    case 'button': return [{ t: 'button', button: event.button, action: event.action }];
    case 'scroll': return [{ t: 'scroll', dx: event.dx, dy: event.dy }];
    case 'key': {
      const mods = [...new Set(event.modifiers ?? [])].map(m => MOD[m]);
      if (mods.some(m => m === undefined)) throw new Error('INPUT_UNAVAILABLE');
      const code = KEY[event.key];
      if (code === undefined) throw new Error('INPUT_UNAVAILABLE');
      return [{ t: 'key', codes: [...mods, code] as number[], action: event.action === 'down' ? 'down' : event.action === 'up' ? 'up' : 'click' }];
    }
    case 'text': return event.text ? [{ t: 'text', text: event.text }] : [];
  }
}

export class WaylandInputDevice implements InputDevice {
  private worker?: ChildProcessWithoutNullStreams;
  private dead = false;
  private heldButtons = new Set<string>();
  private heldKeys = new Set<string>(); // the codes JSON of each held key chord
  private heldOrder: string[] = []; // press order, so release unwinds the latest chord first
  constructor(private readonly spawnFn: Spawn = defaultSpawn) {}

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('INPUT_UNAVAILABLE');
    await this.checkAccess();
    const w = this.spawnFn('python3', ['-c', HELPER_SCRIPT]);
    this.worker = w;
    this.dead = false;
    w.stderr.resume();
    let exitedEarly = false;
    w.on('error', () => { this.dead = true; });
    w.on('exit', () => { exitedEarly = true; this.dead = true; this.worker = undefined; });
    // A helper that cannot create the device (no uinput access, no python3) exits at once; give it a moment.
    await new Promise<void>((resolve, reject) => setTimeout(() => (exitedEarly || this.dead
      ? reject(new Error('INPUT_UNAVAILABLE')) : resolve()), 200));
    if (signal.aborted) { this.kill(); throw new Error('INPUT_UNAVAILABLE'); }
    signal.addEventListener('abort', () => { void this.releaseAll().finally(() => this.kill()); }, { once: true });
  }

  async apply(event: InputEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.dead || !this.worker) throw new Error('INPUT_UNAVAILABLE');
    const messages = toWaylandEvents(event);
    for (const message of messages.filter(m => m.t !== 'text')) {
      this.track(message);
      this.write(message);
    }
    for (const message of messages.filter(m => m.t === 'text')) await this.typeOnce(message.text!, signal);
  }

  private async typeOnce(text: string, signal: AbortSignal): Promise<void> {
    // Free-text typing needs keysym translation, which uinput alone cannot do; ydotool (same uinput access) handles it.
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('INPUT_UNAVAILABLE'));
      let p: ChildProcessWithoutNullStreams;
      try { p = this.spawnFn('ydotool', ['type', text]); } catch { fail(); return; }
      p.stdout.resume(); p.stderr.resume();
      const onAbort = () => { p.kill(); fail(); };
      signal.addEventListener('abort', onAbort, { once: true });
      p.on('error', () => { signal.removeEventListener('abort', onAbort); fail(); });
      p.on('exit', code => { signal.removeEventListener('abort', onAbort); code === 0 ? resolve() : fail(); });
    });
  }

  async releaseAll(): Promise<void> {
    const releases: WaylandInputEvent[] = [...this.heldButtons].map(button => ({ t: 'button', button, action: 'up' }));
    for (const held of [...this.heldOrder].reverse()) releases.push({ t: 'key', codes: JSON.parse(held) as number[], action: 'up' });
    this.heldButtons.clear(); this.heldKeys.clear(); this.heldOrder = [];
    for (const message of releases) { try { this.write(message); } catch { /* best effort; the worker is killed next */ } }
  }

  async dispose(): Promise<void> { await this.releaseAll(); this.kill(); }

  private track(message: WaylandInputEvent): void {
    if (message.t === 'button') {
      if (message.action === 'down') this.heldButtons.add(message.button!);
      else if (message.action === 'up') this.heldButtons.delete(message.button!);
    } else if (message.t === 'key') {
      const chord = JSON.stringify(message.codes);
      if (message.action === 'down') {
        if (!this.heldKeys.has(chord)) { this.heldKeys.add(chord); this.heldOrder.push(chord); }
      } else if (message.action === 'up') {
        this.heldKeys.delete(chord); this.heldOrder = this.heldOrder.filter(h => h !== chord);
      }
    }
  }

  private write(message: WaylandInputEvent): void {
    const w = this.worker; if (!w || this.dead) throw new Error('INPUT_UNAVAILABLE');
    if (!w.stdin.write(JSON.stringify(message) + '\n', 'utf8')) { /* buffered: python drains in order */ }
  }

  /** The honest availability gate: without write access to /dev/uinput there is no Wayland input path. */
  protected async checkAccess(): Promise<void> {
    try { await access('/dev/uinput', constants.W_OK); } catch { throw new Error('INPUT_UNAVAILABLE'); }
  }

  private kill(): void { const w = this.worker; this.worker = undefined; w?.kill(); }
}
