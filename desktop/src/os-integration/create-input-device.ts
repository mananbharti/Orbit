/** Selects the native input adapter: Windows uses SendInput; Linux uses the uinput virtual device on Wayland
 *  and xdotool/XTEST on X11 (XTEST events only reach XWayland clients under Wayland, so the session type picks
 *  the adapter, not display availability); other platforms have no adapter. */
import type { InputDevice } from './input-device.js';
import { WindowsInputDevice } from './input-device.windows.js';
import { LinuxInputDevice } from './input-device.linux.js';
import { WaylandInputDevice } from './input-device.wayland.js';

export function inputDeviceFactory(environment: NodeJS.ProcessEnv = process.env): (() => InputDevice) | undefined {
  if (process.platform === 'win32') return () => new WindowsInputDevice();
  if (process.platform === 'linux') {
    const wayland = !!environment.WAYLAND_DISPLAY || environment.XDG_SESSION_TYPE === 'wayland';
    return wayland ? () => new WaylandInputDevice() : () => new LinuxInputDevice();
  }
  return undefined;
}
