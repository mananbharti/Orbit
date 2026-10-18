/** Per-app volume on Linux through pactl sink inputs; depends on pactl; fails closed when PulseAudio/PipeWire is absent. */
import { execFile } from 'node:child_process';
import type { AudioMixerAdapter, AudioSession } from './audio-mixer.js';
import { AudioMixerUnavailable } from './audio-mixer.js';

const TIMEOUT_MS = 5_000;
export type PactlTool = (args: string[]) => Promise<string>;
const execPactl: PactlTool = args => new Promise((resolve, reject) => {
  execFile('pactl', args, { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
    (error, stdout) => { if (error) reject(new AudioMixerUnavailable('pactl is unavailable')); else resolve(String(stdout)); });
});

export class LinuxAudioMixer implements AudioMixerAdapter {
  constructor(private readonly pactl: PactlTool = execPactl) {}
  async listSessions(): Promise<AudioSession[]> {
    const out = await this.pactl(['-f', 'json', 'list', 'sink-inputs']);
    let inputs: { index?: number; volume?: Record<string, { value_percent?: string }>; mute?: boolean; properties?: Record<string, string> }[];
    try { inputs = JSON.parse(out); } catch { throw new AudioMixerUnavailable('Could not read audio sessions'); }
    const sessions: AudioSession[] = [];
    for (const input of Array.isArray(inputs) ? inputs : []) {
      const pid = Number(input.properties?.['application.process.id']);
      if (!Number.isSafeInteger(pid) || pid <= 0 || typeof input.index !== 'number') continue;
      const first = Object.values(input.volume ?? {})[0];
      sessions.push({ id: String(pid), name: (input.properties?.['application.name'] ?? 'Unknown').slice(0, 128),
        volume: Math.min(100, Number.parseInt(first?.value_percent ?? '0', 10) || 0), muted: input.mute === true });
    }
    return sessions;
  }
  async setSession(id: string, level?: number, muted?: boolean): Promise<void> {
    if (!/^[0-9]{1,10}$/.test(id)) throw new AudioMixerUnavailable('Invalid session id');
    const sessions = await this.listSessions();
    if (!sessions.some(session => session.id === id)) throw new AudioMixerUnavailable('That app is no longer playing audio');
    // pactl addresses sink inputs by index; resolve the index for the pid we validated.
    const out = await this.pactl(['-f', 'json', 'list', 'sink-inputs']);
    const inputs = JSON.parse(out) as { index?: number; properties?: Record<string, string> }[];
    const input = (Array.isArray(inputs) ? inputs : []).find(i => i.properties?.['application.process.id'] === id);
    if (typeof input?.index !== 'number') throw new AudioMixerUnavailable('That app is no longer playing audio');
    if (level !== undefined) {
      if (!Number.isInteger(level) || level < 0 || level > 100) throw new AudioMixerUnavailable('Volume must be 0-100');
      await this.pactl(['set-sink-input-volume', String(input.index), `${level}%`]);
    }
    if (muted !== undefined) await this.pactl(['set-sink-input-mute', String(input.index), muted ? '1' : '0']);
  }
}
