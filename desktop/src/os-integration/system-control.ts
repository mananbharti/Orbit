/** Defines native power/volume/brightness capabilities; depends on nothing but types; adapters fail closed. */
export interface SystemControlAdapter {
  power(action: 'lock' | 'sleep' | 'restart' | 'shutdown'): Promise<void>;
  getVolume(): Promise<{ level: number; muted: boolean }>;
  setVolume(level: number, muted?: boolean): Promise<void>;
  /** Null when the machine has no controllable display backlight (most desktops). */
  getBrightness(): Promise<number | null>;
  setBrightness(level: number): Promise<void>;
  /** Display mode: dark/light app theme, plus night light where the OS exposes it safely. Null per field when unsupported. */
  getDisplayMode(): Promise<DisplayMode>;
  setDisplayMode(mode: { theme?: 'dark' | 'light'; nightLight?: boolean }): Promise<void>;
}

export interface DisplayMode { theme: 'dark' | 'light' | null; nightLight: boolean | null }
export class SystemControlUnavailable extends Error {
  constructor(message = 'System control unavailable on this machine') { super(message); }
}
