/** Linux pointer and keyboard through xdotool (X11/XTEST); depends on an xdotool binary and DISPLAY; never logs typed text and releases every held button and key on abort. Wayland sessions have no XTEST, so the availability probe fails there by design. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { InputEvent } from '../protocol/input.js';
import type { InputDevice } from './input-device.js';

type Spawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;
// xdotool refuses multi-byte text under a C/POSIX locale, so force a UTF-8 one (a no-op where C.UTF-8 is missing).
const defaultSpawn: Spawn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' } });

const BTN: Record<string, string> = { left: '1', middle: '2', right: '3' };
const KEY: Record<string, string> = { enter: 'Return', backspace: 'BackSpace', delete: 'Delete', tab: 'Tab', escape: 'Escape', space: 'space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  volumeup: 'XF86AudioRaiseVolume', volumedown: 'XF86AudioLowerVolume', mute: 'XF86AudioMute', playpause: 'XF86AudioPlay', next: 'XF86AudioNext', previous: 'XF86AudioPrev',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6', f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12' };
const MOD: Record<string, string> = { shift: 'Shift_L', ctrl: 'Control_L', alt: 'Alt_L', meta: 'Super_L' };
const keysym = (key: string): string => KEY[key] ?? key; // letters and digits are their own keysyms
const SCROLL_UNITS_PER_NOTCH = 30; // one phone scroll unit of 30 ~ one wheel notch, matching the Windows adapter's feel
const MAX_NOTCHES = 10;

/** Pure translation of one event into xdotool argv words; one inner array per invocation. */
export function toCommands(event: InputEvent): string[][] {
  switch (event.t) {
    case 'move': return [['mousemove_relative', '--', String(event.dx), String(event.dy)]];
    case 'button': {
      const n = BTN[event.button]!;
      return event.action === 'down' ? [['mousedown', n]] : event.action === 'up' ? [['mouseup', n]] : [['click', n]];
    }
    case 'scroll': {
      const out: string[][] = [];
      const notch = (units: number, positive: string, negative: string): void => {
        if (!units) return;
        const n = Math.min(MAX_NOTCHES, Math.max(1, Math.round(Math.abs(units) / SCROLL_UNITS_PER_NOTCH)));
        out.push(['click', '--repeat', String(n), units > 0 ? positive : negative]);
      };
      notch(event.dy, '5', '4'); // dy > 0 scrolls down, mirroring the Windows wheel sign
      notch(event.dx, '7', '6');
      return out;
    }
    case 'key': {
      const mods = [...new Set(event.modifiers ?? [])].map(m => MOD[m]!);
      const key = keysym(event.key);
      if (event.action === 'down') return [...mods.map(m => ['keydown', m]), ['keydown', key]];
      if (event.action === 'up') return [['keyup', key], ...[...mods].reverse().map(m => ['keyup', m])];
      return [['key', [...mods, key].join('+')]]; // one atomic chord, nothing left held
    }
    case 'text': return event.text ? [['type', '--', event.text]] : [];
  }
}

export class LinuxInputDevice implements InputDevice {
  private worker?: ChildProcessWithoutNullStreams;
  private dead = false;
  private heldButtons = new Set<string>();
  private heldKeys: string[] = [];
  constructor(private readonly spawnFn: Spawn = defaultSpawn) {}

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted || !process.env.DISPLAY) throw new Error('INPUT_UNAVAILABLE');
    await this.probe();
    const w = this.spawnFn('xdotool', ['-']); // reads command lines from stdin
    this.worker = w;
    this.dead = false;
    w.stderr.resume();
    w.on('error', () => { this.dead = true; });
    w.on('exit', () => { this.dead = true; this.worker = undefined; });
    signal.addEventListener('abort', () => { void this.releaseAll().finally(() => this.drainKill()); }, { once: true });
  }

  async apply(event: InputEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.dead || !this.worker) throw new Error('INPUT_UNAVAILABLE');
    const commands = toCommands(event);
    const workerCommands = commands.filter(c => c[0] !== 'type');
    for (const argv of workerCommands) this.track(argv);
    this.write(workerCommands);
    // Script-mode lines split on whitespace, so typed text goes through a one-shot argv spawn instead.
    for (const argv of commands.filter(c => c[0] === 'type')) await this.typeOnce(argv[2]!, signal);
  }

  private async typeOnce(text: string, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('INPUT_UNAVAILABLE'));
      let p: ChildProcessWithoutNullStreams;
      try { p = this.spawnFn('xdotool', ['type', '--', text]); } catch { fail(); return; }
      p.stdout.resume(); p.stderr.resume();
      const onAbort = () => { p.kill(); fail(); };
      signal.addEventListener('abort', onAbort, { once: true });
      p.on('error', () => { signal.removeEventListener('abort', onAbort); fail(); });
      p.on('exit', code => { signal.removeEventListener('abort', onAbort); code === 0 ? resolve() : fail(); });
    });
  }

  async releaseAll(): Promise<void> {
    const commands: string[][] = [...this.heldButtons].map(n => ['mouseup', n])
      .concat([...this.heldKeys].reverse().map(k => ['keyup', k]));
    this.heldButtons.clear(); this.heldKeys = [];
    if (commands.length && this.worker && !this.dead) { try { this.write(commands); } catch { /* best effort; the worker is killed next */ } }
  }

  async dispose(): Promise<void> { await this.releaseAll(); await this.drainKill(); }

  /** A bare kill can land while the worker is mid-keystroke (the atomic down/up pair of a 'key' command, or queued release lines), leaving a key logically held on the server - observed live as F5 autorepeating with no release when a quick send-then-end killed the worker. Close stdin and give the worker a bounded window to drain and exit before killing. */
  private async drainKill(): Promise<void> {
    const w = this.worker; this.worker = undefined;
    if (!w) return;
    try { w.stdin.end(); } catch { /* already closed */ }
    const drained = await new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 2000);
      w.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    if (!drained) w.kill();
  }

  private track(argv: string[]): void {
    const [cmd, a] = argv;
    if (cmd === 'mousedown') this.heldButtons.add(a!);
    else if (cmd === 'mouseup') this.heldButtons.delete(a!);
    else if (cmd === 'keydown') { if (!this.heldKeys.includes(a!)) this.heldKeys.push(a!); }
    else if (cmd === 'keyup') this.heldKeys = this.heldKeys.filter(k => k !== a);
  }

  private write(commands: string[][]): void {
    const w = this.worker; if (!w) throw new Error('INPUT_UNAVAILABLE');
    for (const argv of commands)
      if (!w.stdin.write(argv.join(' ') + '\n', 'utf8')) continue; // buffered: xdotool drains in order
  }

  private async probe(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let p: ChildProcessWithoutNullStreams;
      try { p = this.spawnFn('xdotool', ['version']); } catch { reject(new Error('INPUT_UNAVAILABLE')); return; }
      p.stdout.resume(); p.stderr.resume();
      p.on('error', () => reject(new Error('INPUT_UNAVAILABLE')));
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error('INPUT_UNAVAILABLE'))));
    });
  }

}
