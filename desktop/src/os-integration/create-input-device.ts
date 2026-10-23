/** Selects the native input adapter: Windows uses SendInput, Linux uses xdotool on X11; other platforms have no adapter. */
import type { InputDevice } from './input-device.js';
import { WindowsInputDevice } from './input-device.windows.js';
import { LinuxInputDevice } from './input-device.linux.js';

export function inputDeviceFactory(): (() => InputDevice) | undefined {
  if (process.platform === 'win32') return () => new WindowsInputDevice();
  if (process.platform === 'linux') return () => new LinuxInputDevice();
  return undefined;
}
