/** Where dictated text lands on this computer: the focused window is identified by handle + process (never by title alone) when capture starts and re-identified before typing; any mismatch or unknown focus fails closed to a preview/copy surface instead of typing into the wrong app. Depends on a platform focus probe and the input adapter; performs no OS calls itself. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Stable identity of one focused window: id is the HWND (Windows) or X window id (X11); pid is its owning process. label is display-only (window title or process name) and never participates in identity. */
export interface FocusHandle { id: string; pid: number; label?: string }
export interface FocusProbe { current(): Promise<FocusHandle | undefined> }
/** Brings a captured window back to the foreground so confirmed insertion lands where the user dictated. */
export interface FocusActivator { activate(handle: FocusHandle): Promise<boolean> }

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
        const out = await spawnImpl(['Add-Type -AssemblyName Microsoft.VisualBasic; Add-Type "using System; using System.Runtime.InteropServices; public class FG { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\"user32.dll\\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }"; $h = [FG]::GetForegroundWindow(); $p = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$p); $n = (Get-Process -Id $p).ProcessName; Write-Output "$($h.ToInt64()) $p $n"']);
        const m = /(-?\d+)\s+(\d+)\s*(.*)/.exec(out);
        const rawId = m?.[1]; const rawPid = m?.[2];
        if (!rawId || !rawPid) return undefined;
        const id = String(BigInt(rawId)); const pid = Number(rawPid);
        if (id === '0' || !Number.isInteger(pid) || pid <= 0) return undefined;
        const label = (m?.[3] ?? '').trim();
        return label ? { id, pid, label } : { id, pid };
      } catch { return undefined; }
    },
  };
}

/** Windows activation: SetForegroundWindow on the captured HWND. */
export function windowsFocusActivator(spawnImpl: (args: string[]) => Promise<string> = async args => (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 5000 })).stdout): FocusActivator {
  return {
    activate: async handle => {
      try {
        const out = await spawnImpl(['Add-Type "using System; using System.Runtime.InteropServices; public class FA { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h); }"; Write-Output ([FA]::SetForegroundWindow([IntPtr]' + handle.id + '))']);
        return /true/i.test(out);
      } catch { return false; }
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
        if (!id || !Number.isInteger(pid) || pid <= 0) return undefined;
        const label = (await spawnImpl('xdotool', ['getwindowname', id]).catch(() => '')).trim();
        return label ? { id, pid, label } : { id, pid };
      } catch { return undefined; }
    },
  };
}

/** X11 activation: xdotool windowactivate. */
export function x11FocusActivator(spawnImpl: (cmd: string, args: string[]) => Promise<string> = async (cmd, args) => (await run(cmd, args, { timeout: 3000 })).stdout): FocusActivator {
  return { activate: async handle => { try { await spawnImpl('xdotool', ['windowactivate', handle.id]); return true; } catch { return false; } } };
}

/** Probe for this session type, or undefined where focus identity cannot be established reliably (Wayland, macOS, unknown): insertion is then never offered. */
export function focusProbeFor(platform: string = process.platform, sessionType: string | undefined = process.env.XDG_SESSION_TYPE): FocusProbe | undefined {
  if (platform === 'win32') return windowsFocusProbe();
  if (platform === 'linux' && sessionType === 'x11') return x11FocusProbe();
  return undefined;
}

/** Activator matching focusProbeFor, or undefined on the same platforms. */
export function focusActivatorFor(platform: string = process.platform, sessionType: string | undefined = process.env.XDG_SESSION_TYPE): FocusActivator | undefined {
  if (platform === 'win32') return windowsFocusActivator();
  if (platform === 'linux' && sessionType === 'x11') return x11FocusActivator();
  return undefined;
}

/** Result of verified typing: fully typed, never started (preview), or cut short when focus changed mid-typing - the untyped remainder is returned so the caller can surface it honestly. */
export type TypeOutcome = { action: 'typed' } | { action: 'preview'; reason: 'focus-changed' } | { action: 'aborted'; remaining: string };

/** Types text in chunks, re-probing focus identity before each chunk and stopping at the first mismatch (the untyped remainder is returned). This only bounds how much can land in the wrong window when focus flips mid-typing; it is race mitigation on an already user-confirmed insertion, not a guarantee - the OS delivers keystrokes to whatever is focused at that instant. */
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

export type ConfirmedInsertOutcome = 'typed' | 'activation-failed' | 'focus-mismatch' | { aborted: string };

/** The only path that types: the user just confirmed this exact target. The captured window is activated, focus identity is re-verified after activation, and only then does chunked typing begin. Any failure keeps the text in the preview surface. */
export async function confirmedInsert(handle: FocusHandle, text: string, probe: FocusProbe, activator: FocusActivator, typeChunk: (chunk: string) => Promise<void>): Promise<ConfirmedInsertOutcome> {
  if (!await activator.activate(handle)) return 'activation-failed';
  const now = await probe.current();
  if (!now || now.id !== handle.id || now.pid !== handle.pid) return 'focus-mismatch';
  const out = await typeVerified(text, handle, probe, typeChunk);
  if (out.action === 'typed') return 'typed';
  if (out.action === 'aborted') return { aborted: out.remaining };
  return 'focus-mismatch';
}

/** Clipboard access needed by paste insertion: read returns the current snapshot (kind 'text' with content, or sensitive/unsupported/oversized), write replaces the selection. */
export interface InsertionClipboard {
  read(): Promise<{ kind: string; text?: string }>;
  write(text: string): Promise<void>;
}

export type PasteInsertOutcome = 'paste-sent' | 'activation-failed' | 'focus-mismatch' | 'focus-lost' | 'paste-failed' | 'clipboard-unavailable' | 'unsupported-target';

/** The transcript reaches the confirmed target through the system clipboard and one paste keystroke, not per-character typing: compared with per-character typing the window in which a focus flip could misdirect text shrinks from seconds to the instant of one keystroke - a smaller race, not a delivery guarantee, and no protection against the user confirming the wrong target. Focus identity is verified after activation and again immediately after the keystroke; a flip seen afterwards is reported honestly as 'focus-lost' (the paste may have gone elsewhere) with no automatic retry or resume. A clipboard holding anything but plain restorable text (password-manager copies, images, oversized content) is never clobbered: insertion reports 'clipboard-unavailable'. The prior clipboard is restored after a short delay so the target's asynchronous paste fetch completes first; on X11 the transcript may be visible to local clipboard readers during that sub-second window. */
export const PASTE_RESTORE_DELAY_MS = 750;

export async function confirmedPaste(handle: FocusHandle, text: string, probe: FocusProbe, activator: FocusActivator,
  clipboard: InsertionClipboard, pasteKey: () => Promise<void>, restoreDelayMs = PASTE_RESTORE_DELAY_MS): Promise<PasteInsertOutcome> {
  let prior: string;
  try {
    const snapshot = await clipboard.read();
    if (snapshot.kind !== 'text' || typeof snapshot.text !== 'string') return 'clipboard-unavailable';
    prior = snapshot.text;
    await clipboard.write(text);
  } catch { return 'clipboard-unavailable'; }
  let outcome: PasteInsertOutcome = 'paste-sent';
  try {
    if (!await activator.activate(handle)) return 'activation-failed';
    const now = await probe.current();
    if (!now || now.id !== handle.id || now.pid !== handle.pid) return 'focus-mismatch';
    try { await pasteKey(); } catch { return 'paste-failed'; }
    const after = await probe.current();
    if (!after || after.id !== handle.id || after.pid !== handle.pid) outcome = 'focus-lost';
  } finally {
    await new Promise(resolve => setTimeout(resolve, restoreDelayMs));
    await clipboard.write(prior).catch(() => {});
  }
  return outcome;
}
