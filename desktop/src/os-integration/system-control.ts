/** Defines native power/volume/brightness capabilities; depends on nothing but types; adapters fail closed. */
export interface SystemControlAdapter {
  power(action: 'lock' | 'sleep' | 'restart' | 'shutdown'): Promise<void>;
  getVolume(): Promise<{ level: number; muted: boolean }>;
  setVolume(level: number, muted?: boolean): Promise<void>;
  /** Null when the machine has no controllable display backlight (most desktops). */
  getBrightness(): Promise<number | null>;
  setBrightness(level: number): Promise<void>;
}
export class SystemControlUnavailable extends Error {
  constructor(message = 'System control unavailable on this machine') { super(message); }
}
