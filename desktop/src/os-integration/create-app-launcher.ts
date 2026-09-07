/** Selects the platform App Launcher lazily; depends on Windows/Linux adapters; performs no discovery or activation at service startup. */
import type { AppLauncherAdapter } from './app-launcher.js';
import { LinuxAppLauncher } from './app-launcher.linux.js';
import { WindowsAppLauncher } from './app-launcher.windows.js';
import { ProtocolError } from '../protocol/errors.js';

export function createAppLauncher(): AppLauncherAdapter {
  if (process.platform === 'win32') return new WindowsAppLauncher();
  if (process.platform === 'linux') return new LinuxAppLauncher();
  throw new ProtocolError('LAUNCHER_UNAVAILABLE');
}
