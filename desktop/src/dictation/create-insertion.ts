/** Builds the phone-confirmed target insertion where this platform can deliver it: Linux/X11 with xdotool and xclip, and only into allowlisted window classes whose paste binding is known. Wayland has no reliable active-window identity and Windows paste delivery is unverified, so insertion is not offered there; unknown window classes are refused rather than sent a keystroke that could trigger an unrelated action. Depends on the focus probe/activator, the Linux clipboard adapter and xdotool/xprop; performs no OS calls until used. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confirmedPaste, focusActivatorFor, focusProbeFor, type FocusHandle } from './local-insert.js';
import { LinuxClipboard } from '../os-integration/clipboard.linux.js';
import type { DictationInsertion } from './dictation-service.js';

const run = promisify(execFile);

/** Terminal emulators paste CLIPBOARD with Ctrl+Shift+V (Ctrl+V is quoted-insert there). */
const TERMINAL_WINDOW_CLASSES = /^(xterm|xfce4-terminal|gnome-terminal|konsole|alacritty|kitty|wezterm|tilix|lxterminal|mate-terminal|st|urxvt)/i;
/** GUI applications whose text surfaces paste CLIPBOARD with Ctrl+V. */
const GUI_TEXT_WINDOW_CLASSES = /^(google-chrome|chromium|firefox|gedit|gnome-text-editor|kate|mousepad|code|sublime_text|geany|xed|pluma|notepadqq|libreoffice)/i;

/** The paste binding known for a window class, or undefined when the class is not allowlisted: no keystroke is ever sent to an unknown target. A known class names a paste binding, not a delivery guarantee - the target never acknowledges the paste. */
export function pasteKeySequence(windowClass: string): string | undefined {
  if (TERMINAL_WINDOW_CLASSES.test(windowClass)) return 'ctrl+shift+v';
  if (GUI_TEXT_WINDOW_CLASSES.test(windowClass)) return 'ctrl+v';
  return undefined;
}

async function windowClassOf(handle: FocusHandle): Promise<string> {
  const out = (await run('xprop', ['-id', handle.id, 'WM_CLASS'], { timeout: 3000 })).stdout;
  return /"[^"]*"\s*,\s*"([^"]*)"/.exec(out)?.[1] ?? /"([^"]*)"/.exec(out)?.[1] ?? '';
}

export function createDictationInsertion(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DictationInsertion | undefined {
  if (platform !== 'linux') return undefined;
  const probe = focusProbeFor(platform, environment.XDG_SESSION_TYPE);
  const activator = focusActivatorFor(platform, environment.XDG_SESSION_TYPE);
  if (!probe || !activator) return undefined;
  let clipboard: LinuxClipboard;
  try { clipboard = new LinuxClipboard(environment); } catch { return undefined; }
  return {
    // Insertion is offered only when the captured target's paste binding is known.
    captureFocus: async () => {
      const handle = await probe.current();
      if (!handle) return undefined;
      let windowClass = '';
      try { windowClass = await windowClassOf(handle); } catch { return undefined; }
      return pasteKeySequence(windowClass) ? handle : undefined;
    },
    insert: async (handle, text) => {
      let windowClass = '';
      try { windowClass = await windowClassOf(handle); } catch { return 'unsupported-target'; }
      const sequence = pasteKeySequence(windowClass);
      if (!sequence) return 'unsupported-target';
      return confirmedPaste(handle, text, probe, activator, clipboard,
        async () => { await run('xdotool', ['key', sequence], { timeout: 3000 }); });
    },
  };
}
