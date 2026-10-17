/** Defines per-application volume capabilities; depends on nothing but types; adapters fail closed. */
export interface AudioSession { id: string; name: string; volume: number; muted: boolean }
export interface AudioMixerAdapter {
  listSessions(): Promise<AudioSession[]>;
  setSession(id: string, level?: number, muted?: boolean): Promise<void>;
}
export class AudioMixerUnavailable extends Error {
  constructor(message = 'Per-app audio mixing is unavailable on this machine') { super(message); }
}
