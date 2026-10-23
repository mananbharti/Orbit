/** Routes power, volume, brightness and media transport commands from paired phones to the OS adapters; depends on the command registry and ActivityLog. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { InputDevice } from '../os-integration/input-device.js';
import type { SystemControlAdapter } from '../os-integration/system-control.js';
import { SystemControlUnavailable } from '../os-integration/system-control.js';
import { brightnessSetSchema, emptySystemSchema, mediaTransportSchema, modeSetSchema, powerSchema, volumeSetSchema } from '../protocol/system-control.js';
import { ProtocolError } from '../protocol/errors.js';

export class SystemControl {
  private readonly unregister: (() => void)[];
  private adapterInstance?: SystemControlAdapter;
  private inputInstance?: InputDevice;

  /** The optional input-device factory powers media transport keys; without one the media command reports SYSTEM_UNAVAILABLE. */
  constructor(registry: CommandRegistry, private readonly createAdapter: () => SystemControlAdapter, private readonly log: ActivityLog,
    private readonly createInputDevice?: () => InputDevice) {
    const ready = (): SystemControlAdapter => (this.adapterInstance ??= this.createAdapter());
    const guard = (context: CommandContext): void => {
      if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
    };
    type SystemEvent = 'system.power' | 'system.volume' | 'system.brightness' | 'system.mode' | 'system.media';
    const call = async <T>(context: CommandContext, eventType: SystemEvent, fn: (a: SystemControlAdapter) => Promise<T>): Promise<T> => {
      guard(context);
      try {
        const result = await fn(ready());
        this.log.record({ severity: 'info', eventType, outcome: 'success', deviceId: context.session.deviceId });
        return result;
      } catch (error) {
        this.log.record({ severity: 'warn', eventType, outcome: 'failed', deviceId: context.session.deviceId });
        if (error instanceof SystemControlUnavailable) throw new ProtocolError('SYSTEM_UNAVAILABLE');
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('SYSTEM_UNAVAILABLE');
      }
    };
    this.unregister = [
      registry.register('system.power', { validate: payload => powerSchema.safeParse(payload).success,
        execute: async (payload, context) => { const { action } = powerSchema.parse(payload); await call(context, 'system.power', a => a.power(action)); return { status: 'requested' }; } }),
      registry.register('system.volume.get', { validate: payload => emptySystemSchema.safeParse(payload).success,
        execute: (_payload, context) => call(context, 'system.volume', a => a.getVolume()) }),
      registry.register('system.volume.set', { validate: payload => volumeSetSchema.safeParse(payload).success,
        execute: async (payload, context) => { const v = volumeSetSchema.parse(payload); await call(context, 'system.volume', a => a.setVolume(v.level, v.muted)); return { applied: true }; } }),
      registry.register('system.brightness.get', { validate: payload => emptySystemSchema.safeParse(payload).success,
        execute: async (_payload, context) => call(context, 'system.brightness', async a => ({ level: await a.getBrightness() })) }),
      registry.register('system.brightness.set', { validate: payload => brightnessSetSchema.safeParse(payload).success,
        execute: async (payload, context) => { const b = brightnessSetSchema.parse(payload); await call(context, 'system.brightness', a => a.setBrightness(b.level)); return { applied: true }; } }),
      registry.register('system.mode.get', { validate: payload => emptySystemSchema.safeParse(payload).success,
        execute: async (_payload, context) => call(context, 'system.mode', async a => { const m = await a.getDisplayMode(); return { theme: m.theme, nightLight: m.nightLight }; }) }),
      registry.register('system.mode.set', { validate: payload => modeSetSchema.safeParse(payload).success,
        execute: async (payload, context) => { const m = modeSetSchema.parse(payload); await call(context, 'system.mode', a => a.setDisplayMode(m)); return { applied: true }; } }),
      // Media transport needs no control session: one scoped, authorized command sends one media key.
      registry.register('system.media.transport', { validate: payload => mediaTransportSchema.safeParse(payload).success,
        execute: async (payload, context) => {
          const { action } = mediaTransportSchema.parse(payload);
          guard(context);
          if (!this.createInputDevice) {
            this.log.record({ severity: 'warn', eventType: 'system.media', outcome: 'failed', deviceId: context.session.deviceId });
            throw new ProtocolError('SYSTEM_UNAVAILABLE');
          }
          try {
            this.inputInstance ??= this.createInputDevice();
            await this.inputInstance.apply({ t: 'key', key: action },
              context.connection?.closed ?? new AbortController().signal);
            this.log.record({ severity: 'info', eventType: 'system.media', outcome: 'success', deviceId: context.session.deviceId });
            return { applied: true };
          } catch (error) {
            this.log.record({ severity: 'warn', eventType: 'system.media', outcome: 'failed', deviceId: context.session.deviceId });
            if (error instanceof ProtocolError) throw error;
            throw new ProtocolError('SYSTEM_UNAVAILABLE');
          }
        } }),
    ];
  }

  /** Power action initiated by the computer itself (a schedule), not by a phone: no session exists to authorize. */
  async powerLocal(action: 'sleep' | 'lock'): Promise<void> {
    await (this.adapterInstance ??= this.createAdapter()).power(action);
  }

  stop(): void { for (const unregister of this.unregister.splice(0)) unregister(); }
}
