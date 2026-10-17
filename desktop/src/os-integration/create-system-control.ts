/** Selects the native system-control adapter for this platform; depends on the Windows/Linux adapters. */
import type { SystemControlAdapter } from './system-control.js';
import { SystemControlUnavailable } from './system-control.js';
import { WindowsSystemControl } from './system-control.windows.js';
import { LinuxSystemControl } from './system-control.linux.js';

export function createSystemControl(): SystemControlAdapter {
  if (process.platform === 'win32') return new WindowsSystemControl();
  if (process.platform === 'linux') return new LinuxSystemControl();
  throw new SystemControlUnavailable();
}
