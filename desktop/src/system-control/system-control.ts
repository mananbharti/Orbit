/** Routes power, volume and brightness commands from paired phones to the OS adapter; depends on the command registry and ActivityLog. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { SystemControlAdapter } from '../os-integration/system-control.js';
import { SystemControlUnavailable } from '../os-integration/system-control.js';
import { brightnessSetSchema, emptySystemSchema, powerSchema, volumeSetSchema } from '../protocol/system-control.js';
import { ProtocolError } from '../protocol/errors.js';

export class SystemControl {
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly createAdapter: () => SystemControlAdapter, private readonly log: ActivityLog) {
    let adapter: SystemControlAdapter | undefined;
    const ready = (): SystemControlAdapter => (adapter ??= this.createAdapter());
    const guard = (context: CommandContext): void => {
      if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
    };
    type SystemEvent = 'system.power' | 'system.volume' | 'system.brightness';
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
    ];
  }

  stop(): void { for (const unregister of this.unregister.splice(0)) unregister(); }
}
