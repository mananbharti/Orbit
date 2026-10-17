/** Windows pointer and keyboard through SendInput in one PowerShell worker; depends on powershell.exe; UNTESTED ON A REAL WINDOWS PC. Never logs typed text and releases every held button and key on abort. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { InputEvent } from '../protocol/input.js';
import type { InputDevice } from './input-device.js';
import { windowsPowerShellEnv } from './powershell-env.js';

export type Op = { k: 'mouse'; flags: number; dx?: number; dy?: number; data?: number } | { k: 'key'; vk: number; flags: number } | { k: 'uni'; scan: number; flags: number };
const KEYUP = 0x2, EXT = 0x1, UNICODE = 0x4;
const VK: Record<string, [number, boolean]> = { enter: [0x0d, false], backspace: [0x08, false], delete: [0x2e, true], tab: [0x09, false], escape: [0x1b, false], space: [0x20, false],
  up: [0x26, true], down: [0x28, true], left: [0x25, true], right: [0x27, true], home: [0x24, true], end: [0x23, true], pageup: [0x21, true], pagedown: [0x22, true],
  volumeup: [0xaf, false], volumedown: [0xae, false], mute: [0xad, false], playpause: [0xb3, false], next: [0xb0, false], previous: [0xb1, false],
  a: [0x41, false], b: [0x42, false], c: [0x43, false], d: [0x44, false], e: [0x45, false], f: [0x46, false], g: [0x47, false], h: [0x48, false], i: [0x49, false], j: [0x4a, false], k: [0x4b, false], l: [0x4c, false], m: [0x4d, false], n: [0x4e, false], o: [0x4f, false], p: [0x50, false], q: [0x51, false], r: [0x52, false], s: [0x53, false], t: [0x54, false], u: [0x55, false], v: [0x56, false], w: [0x57, false], x: [0x58, false], y: [0x59, false], z: [0x5a, false], 0: [0x30, false], 1: [0x31, false], 2: [0x32, false], 3: [0x33, false], 4: [0x34, false], 5: [0x35, false], 6: [0x36, false], 7: [0x37, false], 8: [0x38, false], 9: [0x39, false], f1: [0x70, false], f2: [0x71, false], f3: [0x72, false], f4: [0x73, false], f5: [0x74, false], f6: [0x75, false], f7: [0x76, false], f8: [0x77, false], f9: [0x78, false], f10: [0x79, false], f11: [0x7a, false], f12: [0x7b, false] };
const MOD: Record<string, number> = { shift: 0x10, ctrl: 0x11, alt: 0x12, meta: 0x5b };
const BTN: Record<string, [number, number]> = { left: [0x2, 0x4], right: [0x8, 0x10], middle: [0x20, 0x40] };
const WHEEL = 0x800, HWHEEL = 0x1000, MOVE = 0x1;
export const SCROLL_SCALE = 4; // wheel units per phone scroll unit; a guess to tune on a real PC

/** Pure translation of one event into SendInput operations. */
export function toOps(event: InputEvent): Op[] {
  switch (event.t) {
    case 'move': return [{ k: 'mouse', flags: MOVE, dx: event.dx, dy: event.dy }];
    case 'button': {
      const [down, up] = BTN[event.button]!;
      return event.action === 'down' ? [{ k: 'mouse', flags: down }] : event.action === 'up' ? [{ k: 'mouse', flags: up }] : [{ k: 'mouse', flags: down }, { k: 'mouse', flags: up }];
    }
    case 'scroll': return [
      ...(event.dy ? [{ k: 'mouse' as const, flags: WHEEL, data: -event.dy * SCROLL_SCALE }] : []),
      ...(event.dx ? [{ k: 'mouse' as const, flags: HWHEEL, data: event.dx * SCROLL_SCALE }] : [])];
    case 'key': {
      const [vk, ext] = VK[event.key]!;
      const mods = [...new Set(event.modifiers ?? [])].map(m => MOD[m]!);
      return [...mods.map(m => ({ k: 'key' as const, vk: m, flags: 0 })), { k: 'key', vk, flags: ext ? EXT : 0 }, { k: 'key', vk, flags: (ext ? EXT : 0) | KEYUP },
        ...[...mods].reverse().map(m => ({ k: 'key' as const, vk: m, flags: KEYUP }))];
    }
    case 'text': {
      const ops: Op[] = [];
      for (let i = 0; i < event.text.length; i++) { const scan = event.text.charCodeAt(i); ops.push({ k: 'uni', scan, flags: UNICODE }, { k: 'uni', scan, flags: UNICODE | KEYUP }); }
      return ops;
    }
  }
}

const WORKER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class OrbitInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] i, int size);
  public static bool Mouse(uint flags, int dx, int dy, int data) { var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dwFlags = flags; i[0].u.mi.dx = dx; i[0].u.mi.dy = dy; i[0].u.mi.mouseData = unchecked((uint)data); return SendInput(1, i, Marshal.SizeOf(typeof(INPUT))) == 1; }
  public static bool Key(ushort vk, ushort scan, uint flags) { var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.wScan = scan; i[0].u.ki.dwFlags = flags; return SendInput(1, i, Marshal.SizeOf(typeof(INPUT))) == 1; }
}
'@
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $ok = $true
    foreach ($op in (ConvertFrom-Json -InputObject $line)) {
      if ($op.k -eq 'mouse') { $ok = $ok -and [OrbitInput]::Mouse([uint32]$op.flags, [int]$op.dx, [int]$op.dy, [int]$op.data) }
      elseif ($op.k -eq 'key') { $ok = $ok -and [OrbitInput]::Key([uint16]$op.vk, 0, [uint32]$op.flags) }
      elseif ($op.k -eq 'uni') { $ok = $ok -and [OrbitInput]::Key(0, [uint16]$op.scan, [uint32]$op.flags) }
    }
    if ($ok) { [Console]::WriteLine('{"ok":true}') } else { [Console]::WriteLine('{"ok":false}') }
  } catch { [Console]::WriteLine('{"ok":false}') }
}
`;

export type Spawn = () => ChildProcessWithoutNullStreams;
const defaultSpawn: Spawn = () => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WORKER], { windowsHide: true, stdio: 'pipe', env: windowsPowerShellEnv() });
const TIMEOUT_MS = 5_000;

export class WindowsInputDevice implements InputDevice {
  private worker?: ChildProcessWithoutNullStreams;
  private lines: string[] = []; private buffer = ''; private waiter?: (line: string) => void;
  private heldButtons = new Set<string>(); private heldKeys = new Set<number>();
  constructor(private readonly spawnWorker: Spawn = defaultSpawn) {}

  async open(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('INPUT_UNAVAILABLE');
    const w = this.spawnWorker(); this.worker = w;
    w.stdout.setEncoding('utf8');
    w.stdout.on('data', (c: string) => { this.buffer += c; if (this.buffer.length > 4096) { this.kill(); return; } let i; while ((i = this.buffer.indexOf('\n')) >= 0) { const l = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1); this.waiter ? this.waiter(l) : this.lines.push(l); this.waiter = undefined; } });
    w.stderr.resume(); w.on('error', () => this.kill()); w.on('exit', () => { this.worker = undefined; this.waiter?.('{"ok":false}'); });
    signal.addEventListener('abort', () => { void this.releaseAll().finally(() => this.kill()); }, { once: true });
    const first = await this.nextLine();
    if (!first.includes('"ready"')) { this.kill(); throw new Error('INPUT_UNAVAILABLE'); }
  }
  async apply(event: InputEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.worker) throw new Error('INPUT_UNAVAILABLE');
    const ops = toOps(event);
    for (const op of ops) this.track(op);
    await this.send(ops);
  }
  async releaseAll(): Promise<void> {
    const ops: Op[] = [...this.heldButtons].map(b => ({ k: 'mouse' as const, flags: BTN[b]![1] })).concat([]);
    const keys: Op[] = [...this.heldKeys].map(vk => ({ k: 'key' as const, vk, flags: KEYUP }));
    this.heldButtons.clear(); this.heldKeys.clear();
    if ((ops.length || keys.length) && this.worker) { try { await this.send([...ops, ...keys]); } catch { /* best effort; the worker is killed next */ } }
  }
  async dispose(): Promise<void> { await this.releaseAll(); this.kill(); }

  private track(op: Op): void {
    if (op.k === 'mouse') for (const [name, [down, up]] of Object.entries(BTN)) { if (op.flags === down) this.heldButtons.add(name); if (op.flags === up) this.heldButtons.delete(name); }
    else if (op.k === 'key') { if (op.flags & KEYUP) this.heldKeys.delete(op.vk); else this.heldKeys.add(op.vk); }
  }
  private async send(ops: Op[]): Promise<void> {
    const w = this.worker; if (!w) throw new Error('INPUT_UNAVAILABLE');
    w.stdin.write(`${JSON.stringify(ops)}\n`, 'utf8');
    const reply = await this.nextLine();
    if (!reply.includes('"ok":true')) throw new Error('INPUT_UNAVAILABLE');
  }
  private nextLine(): Promise<string> {
    const queued = this.lines.shift(); if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; this.kill(); reject(new Error('INPUT_UNAVAILABLE')); }, TIMEOUT_MS);
      this.waiter = l => { clearTimeout(timer); resolve(l); };
    });
  }
  private kill(): void { const w = this.worker; this.worker = undefined; w?.kill(); }
}
