/** Builds the phone-confirmed target insertion where this platform can deliver it safely: Linux/X11 with xdotool and xclip. Wayland has no reliable active-window identity and Windows paste delivery is unverified, so insertion is simply not offered there - dictation still returns text for the preview/copy surface. Depends on the focus probe/activator, the Linux clipboard adapter and xdotool; performs no OS calls until used. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confirmedPaste, focusActivatorFor, focusProbeFor } from './local-insert.js';
import { LinuxClipboard } from '../os-integration/clipboard.linux.js';
import type { DictationInsertion } from './dictation-service.js';

const run = promisify(execFile);

/** Terminal emulators paste CLIPBOARD with Ctrl+Shift+V and treat Ctrl+V as quoted-insert; GUI toolkits paste with Ctrl+V. The wrong choice fails benignly (nothing is pasted), never with wrong content. */
const TERMINAL_WINDOW_CLASSES = /^(xterm|xfce4-terminal|gnome-terminal|konsole|alacritty|kitty|wezterm|tilix|lxterminal|mate-terminal|st|urxvt)/i;
export function pasteKeySequence(windowClass: string): string {
  return TERMINAL_WINDOW_CLASSES.test(windowClass) ? 'ctrl+shift+v' : 'ctrl+v';
}

export function createDictationInsertion(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DictationInsertion | undefined {
  if (platform !== 'linux') return undefined;
  const probe = focusProbeFor(platform, environment.XDG_SESSION_TYPE);
  const activator = focusActivatorFor(platform, environment.XDG_SESSION_TYPE);
  if (!probe || !activator) return undefined;
  let clipboard: LinuxClipboard;
  try { clipboard = new LinuxClipboard(environment); } catch { return undefined; }
  return {
    captureFocus: () => probe.current(),
    insert: async (handle, text) => {
      let windowClass = '';
      try {
        const out = (await run('xprop', ['-id', handle.id, 'WM_CLASS'], { timeout: 3000 })).stdout;
        windowClass = /"[^"]*"\s*,\s*"([^"]*)"/.exec(out)?.[1] ?? /"([^"]*)"/.exec(out)?.[1] ?? '';
      } catch { /* unknown class: the GUI default applies */ }
      return confirmedPaste(handle, text, probe, activator, clipboard,
        async () => { await run('xdotool', ['key', pasteKeySequence(windowClass)], { timeout: 3000 }); });
    },
  };
}
