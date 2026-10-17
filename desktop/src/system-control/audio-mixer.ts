/** Routes per-app audio mixer commands from paired phones to the OS adapter; depends on the command registry and ActivityLog. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { AudioMixerAdapter } from '../os-integration/audio-mixer.js';
import { AudioMixerUnavailable } from '../os-integration/audio-mixer.js';
import { audioSessionSetSchema, audioSessionsResultSchema } from '../protocol/audio-mixer.js';
import { emptySystemSchema } from '../protocol/system-control.js';
import { ProtocolError } from '../protocol/errors.js';

export class AudioMixer {
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly createAdapter: () => AudioMixerAdapter, private readonly log: ActivityLog) {
    let adapter: AudioMixerAdapter | undefined;
    const ready = (): AudioMixerAdapter => (adapter ??= this.createAdapter());
    const call = async <T>(context: CommandContext, fn: (a: AudioMixerAdapter) => Promise<T>): Promise<T> => {
      if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
      try {
        const result = await fn(ready());
        this.log.record({ severity: 'info', eventType: 'system.audio', outcome: 'success', deviceId: context.session.deviceId });
        return result;
      } catch (error) {
        this.log.record({ severity: 'warn', eventType: 'system.audio', outcome: 'failed', deviceId: context.session.deviceId });
        if (error instanceof ProtocolError) throw error;
        if (error instanceof AudioMixerUnavailable) throw new ProtocolError('SYSTEM_UNAVAILABLE');
        throw new ProtocolError('SYSTEM_UNAVAILABLE');
      }
    };
    this.unregister = [
      registry.register('system.audio.sessions', { validate: payload => emptySystemSchema.safeParse(payload).success,
        execute: async (_payload, context) => {
          const sessions = await call(context, a => a.listSessions());
          return audioSessionsResultSchema.parse({ sessions: sessions.slice(0, 64) });
        } }),
      registry.register('system.audio.session.set', { validate: payload => audioSessionSetSchema.safeParse(payload).success,
        execute: async (payload, context) => {
          const { id, level, muted } = audioSessionSetSchema.parse(payload);
          await call(context, a => a.setSession(id, level, muted));
          return { applied: true };
        } }),
    ];
  }

  stop(): void { for (const unregister of this.unregister.splice(0)) unregister(); }
}
