/** Builds the phone-confirmed target insertion where this platform can deliver it safely: Linux/X11 with xdotool and xclip. Wayland has no reliable active-window identity and Windows paste delivery is unverified, so insertion is simply not offered there - dictation still returns text for the preview/copy surface. Depends on the focus probe/activator, the Linux clipboard adapter and xdotool; performs no OS calls until used. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confirmedPaste, focusActivatorFor, focusProbeFor } from './local-insert.js';
import { LinuxClipboard } from '../os-integration/clipboard.linux.js';
import type { DictationInsertion } from './dictation-service.js';

const run = promisify(execFile);

export function createDictationInsertion(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): DictationInsertion | undefined {
  if (platform !== 'linux') return undefined;
  const probe = focusProbeFor(platform, environment.XDG_SESSION_TYPE);
  const activator = focusActivatorFor(platform, environment.XDG_SESSION_TYPE);
  if (!probe || !activator) return undefined;
  let clipboard: LinuxClipboard;
  try { clipboard = new LinuxClipboard(environment); } catch { return undefined; }
  return {
    captureFocus: () => probe.current(),
    insert: (handle, text) => confirmedPaste(handle, text, probe, activator, clipboard,
      async () => { await run('xdotool', ['key', 'shift+Insert'], { timeout: 3000 }); }),
  };
}
