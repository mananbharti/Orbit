/** Routes power, volume and brightness commands from paired phones to the OS adapter; depends on the command registry and ActivityLog. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { SystemControlAdapter } from '../os-integration/system-control.js';
import { SystemControlUnavailable } from '../os-integration/system-control.js';
import { brightnessSetSchema, emptySystemSchema, modeSetSchema, powerSchema, volumeSetSchema } from '../protocol/system-control.js';
import { ProtocolError } from '../protocol/errors.js';

export class SystemControl {
  private readonly unregister: (() => void)[];
  private adapterInstance?: SystemControlAdapter;

  constructor(registry: CommandRegistry, private readonly createAdapter: () => SystemControlAdapter, private readonly log: ActivityLog) {
    const ready = (): SystemControlAdapter => (this.adapterInstance ??= this.createAdapter());
    const guard = (context: CommandContext): void => {
      if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
    };
    type SystemEvent = 'system.power' | 'system.volume' | 'system.brightness' | 'system.mode';
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
    ];
  }

  /** Power action initiated by the computer itself (a schedule), not by a phone: no session exists to authorize. */
  async powerLocal(action: 'sleep' | 'lock'): Promise<void> {
    await (this.adapterInstance ??= this.createAdapter()).power(action);
  }

  stop(): void { for (const unregister of this.unregister.splice(0)) unregister(); }
}
