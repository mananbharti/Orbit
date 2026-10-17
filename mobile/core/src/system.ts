/** Power, volume and brightness control of the paired desktop; depends on OrbitSession and Zod. */
import { InvalidDesktopReply } from './agent.js';
import { z } from 'zod';
import type { JsonValue } from './protocol.js';
import { NotSent, type OrbitSession } from './session.js';

const powerResultSchema = z.strictObject({ status: z.literal('requested') });
const volumeStateSchema = z.strictObject({ level: z.number().int().min(0).max(100), muted: z.boolean() });
const brightnessResultSchema = z.strictObject({ level: z.number().int().min(0).max(100).nullable() });
const appliedSchema = z.strictObject({ applied: z.literal(true) });
const panicResultSchema = z.strictObject({ status: z.enum(['locked', 'unpaired']) });
const audioSessionSchema = z.strictObject({ id: z.string().regex(/^[0-9]{1,10}$/), name: z.string().min(1).max(128),
  volume: z.number().int().min(0).max(100), muted: z.boolean() });
const audioSessionsResultSchema = z.strictObject({ sessions: z.array(audioSessionSchema).max(64) });

export type PowerAction = 'lock' | 'sleep' | 'restart' | 'shutdown';
export interface VolumeState { level: number; muted: boolean }
export interface AudioSession { id: string; name: string; volume: number; muted: boolean }

export class SystemApi {
  constructor(private readonly session: OrbitSession) {}
  private async call(type: string, payload: Record<string, JsonValue>, schema: z.ZodTypeAny): Promise<unknown> {
    if (this.session.status !== 'connected') throw new NotSent('Not connected');
    const result: unknown = await this.session.command(type, payload, { timeoutMs: 15_000 });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    return parsed.data;
  }
  power(action: PowerAction): Promise<void> {
    return this.call('system.power', { action }, powerResultSchema).then(() => {});
  }
  /** Per-app volume: apps currently playing audio on the computer. */
  audioSessions(): Promise<AudioSession[]> {
    return this.call('system.audio.sessions', {}, audioSessionsResultSchema).then(r => (r as { sessions: AudioSession[] }).sessions);
  }
  setAudioSession(id: string, level?: number, muted?: boolean): Promise<void> {
    return this.call('system.audio.session.set', { id, ...(level !== undefined ? { level } : {}), ...(muted !== undefined ? { muted } : {}) }, appliedSchema).then(() => {});
  }
  /** Locks the PC (best effort) and unpairs this phone immediately; the session dies right after the reply. */
  panic(): Promise<'locked' | 'unpaired'> {
    return this.call('system.panic', {}, panicResultSchema).then(r => (r as { status: 'locked' | 'unpaired' }).status);
  }
  getVolume(): Promise<VolumeState> {
    return this.call('system.volume.get', {}, volumeStateSchema) as Promise<VolumeState>;
  }
  setVolume(level: number, muted?: boolean): Promise<void> {
    return this.call('system.volume.set', { level, ...(typeof muted === 'boolean' ? { muted } : {}) }, appliedSchema).then(() => {});
  }
  /** Null when the computer has no controllable backlight (most desktops). */
  getBrightness(): Promise<number | null> {
    return (this.call('system.brightness.get', {}, brightnessResultSchema) as Promise<{ level: number | null }>).then(r => r.level);
  }
  setBrightness(level: number): Promise<void> {
    return this.call('system.brightness.set', { level }, appliedSchema).then(() => {});
  }
}
