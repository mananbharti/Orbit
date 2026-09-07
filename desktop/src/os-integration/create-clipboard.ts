/** Selects the native clipboard adapter lazily; depends on Windows/Linux adapters; does not read content at service startup. */
import { ClipboardUnavailable, type ClipboardAdapter } from './clipboard.js';
import { WindowsClipboard } from './clipboard.windows.js';
import { LinuxClipboard } from './clipboard.linux.js';

export function createClipboard(): ClipboardAdapter {
  if (process.platform === 'win32') return new WindowsClipboard();
  if (process.platform === 'linux') return new LinuxClipboard();
  throw new ClipboardUnavailable();
}
