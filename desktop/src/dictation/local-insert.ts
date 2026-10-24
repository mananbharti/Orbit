/** Where dictated text lands on this computer: the focused window is identified by handle + process (never by title alone) when capture starts and re-identified before typing; any mismatch or unknown focus fails closed to a preview/copy surface instead of typing into the wrong app. Depends on a platform focus probe and the input adapter; performs no OS calls itself. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Stable identity of one focused window: id is the HWND (Windows) or X window id (X11); pid is its owning process. */
export interface FocusHandle { id: string; pid: number }
export interface FocusProbe { current(): Promise<FocusHandle | undefined> }

export type InsertDecision = { action: 'type' } | { action: 'preview'; reason: 'focus-changed' | 'focus-unknown' };

/** The only rule that decides between typing and the preview fallback. Pure and total. */
export function decideInsertion(start: FocusHandle | undefined, end: FocusHandle | undefined): InsertDecision {
  if (!start || !end) return { action: 'preview', reason: 'focus-unknown' };
  return start.id === end.id && start.pid === end.pid ? { action: 'type' } : { action: 'preview', reason: 'focus-changed' };
}

/** Windows probe: GetForegroundWindow handle + owning PID via a one-shot PowerShell. */
export function windowsFocusProbe(spawnImpl: (args: string[]) => Promise<string> = async args => (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 5000 })).stdout): FocusProbe {
  return {
    current: async () => {
      try {
        const out = await spawnImpl(['Add-Type -AssemblyName Microsoft.VisualBasic; Add-Type "using System; using System.Runtime.InteropServices; public class FG { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }"; $h = [FG]::GetForegroundWindow(); $p = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$p); Write-Output "$($h.ToInt64()) $p"']);
        const m = /(-?\d+)\s+(\d+)/.exec(out);
        const rawId = m?.[1]; const rawPid = m?.[2];
        if (!rawId || !rawPid) return undefined;
        const id = String(BigInt(rawId)); const pid = Number(rawPid);
        return id === '0' || !Number.isInteger(pid) || pid <= 0 ? undefined : { id, pid };
      } catch { return undefined; }
    },
  };
}

/** X11 probe: xdotool's active window id + PID. Wayland has no reliable cross-compositor active-window identity: callers get no probe and fail closed to preview. */
export function x11FocusProbe(spawnImpl: (cmd: string, args: string[]) => Promise<string> = async (cmd, args) => (await run(cmd, args, { timeout: 3000 })).stdout): FocusProbe {
  return {
    current: async () => {
      try {
        const id = (await spawnImpl('xdotool', ['getactivewindow'])).trim();
        const pid = Number((await spawnImpl('xdotool', ['getwindowpid', id])).trim());
        return id && Number.isInteger(pid) && pid > 0 ? { id, pid } : undefined;
      } catch { return undefined; }
    },
  };
}

/** Probe for this session type, or undefined where focus identity cannot be established reliably (Wayland, macOS, unknown): insertion then always fails closed. */
export function focusProbeFor(platform: string = process.platform, sessionType: string | undefined = process.env.XDG_SESSION_TYPE): FocusProbe | undefined {
  if (platform === 'win32') return windowsFocusProbe();
  if (platform === 'linux' && sessionType === 'x11') return x11FocusProbe();
  return undefined;
}

/** Result of verified typing: fully typed, never started (preview), or cut short when focus changed mid-typing - the untyped remainder is returned so the caller can surface it honestly. */
export type TypeOutcome = { action: 'typed' } | { action: 'preview'; reason: 'focus-changed' } | { action: 'aborted'; remaining: string };

/** Types text in chunks, re-probing focus identity before every chunk. A mismatch before the first chunk means nothing was typed; a mismatch later bounds the leak to the chunks already sent and returns the rest. This narrows the check-then-type race to one chunk instead of the whole utterance. */
export async function typeVerified(text: string, expected: FocusHandle, probe: FocusProbe, typeChunk: (chunk: string) => Promise<void>, chunkSize = 240): Promise<TypeOutcome> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  for (let i = 0; i < chunks.length; i++) {
    const now = await probe.current();
    if (!now || now.id !== expected.id || now.pid !== expected.pid) {
      return i === 0 ? { action: 'preview', reason: 'focus-changed' } : { action: 'aborted', remaining: chunks.slice(i).join('') };
    }
    await typeChunk(chunks[i] as string);
  }
  return { action: 'typed' };
}
