/** Picks the platform audio mixer; depends on platform adapters; unsupported platforms fail closed at call time. */
import type { AudioMixerAdapter } from './audio-mixer.js';
import { AudioMixerUnavailable } from './audio-mixer.js';
import { WindowsAudioMixer } from './audio-mixer.windows.js';
import { LinuxAudioMixer } from './audio-mixer.linux.js';

export function createAudioMixer(): AudioMixerAdapter {
  if (process.platform === 'win32') return new WindowsAudioMixer();
  if (process.platform === 'linux') return new LinuxAudioMixer();
  return { listSessions: async () => { throw new AudioMixerUnavailable(); }, setSession: async () => { throw new AudioMixerUnavailable(); } };
}
