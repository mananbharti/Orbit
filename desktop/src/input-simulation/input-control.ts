/** Registers the input.* commands on top of the guarded control session; depends on the registry and an InputDevice; owns no native code and never skips confirmation. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { InputDevice } from '../os-integration/input-device.js';
import { ProtocolError } from '../protocol/errors.js';
import { beginSchema, macroIdPayloadSchema, saveMacroSchema, sendSchema, sessionRef } from '../protocol/input.js';
import type { KeyboardMacroStore } from './keyboard-macros.js';
import type { BiometricConfirmation } from '../security-pairing/biometric-confirmation.js';
import { InputControlSession } from './control-session.js';

export class InputControl {
  private readonly session: InputControlSession<InputDevice>;
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, createDevice: () => InputDevice, log: ActivityLog, confirmation?: BiometricConfirmation,
    private readonly macros?: KeyboardMacroStore) {
    this.session = new InputControlSession(createDevice, log, confirmation);
    this.unregister = [
      registry.register('input.begin', { validate: p => beginSchema.safeParse(p).success,
        execute: async (_p, context) => ({ ...(await this.session.begin(context)) }) }),
      registry.register('input.keepalive', { validate: p => sessionRef.safeParse(p).success,
        execute: async (p, context) => { this.session.keepalive(context, sessionRef.parse(p).controlSessionId); return { ok: true }; } }),
      registry.register('input.send', { validate: p => sendSchema.safeParse(p).success,
        execute: async (p, context) => {
          const { controlSessionId, sequence, events } = sendSchema.parse(p);
          await this.session.execute(context, controlSessionId, sequence, async (device, signal) => {
            for (const event of events) { if (signal.aborted) throw new ProtocolError('UNAUTHENTICATED'); await device.apply(event, signal); }
          });
          return { nextSequence: sequence + 1 };
        } }),
      registry.register('input.end', { validate: p => sessionRef.safeParse(p).success,
        execute: async (p, context) => { await this.session.end(context, sessionRef.parse(p).controlSessionId); return { ended: true }; } }),
      registry.register('input.macros', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async (_p, context) => {
          if (!this.macros) throw new ProtocolError('INPUT_UNAVAILABLE');
          this.requireAuthorized(context);
          return { macros: this.macros.list() };
        } }),
      registry.register('input.macro.save', { validate: p => saveMacroSchema.safeParse(p).success,
        execute: async (p, context) => {
          if (!this.macros) throw new ProtocolError('INPUT_UNAVAILABLE');
          const { id, name, steps } = saveMacroSchema.parse(p);
          this.requireAuthorized(context);
          try { return { macros: this.macros.save(name, steps, id) }; }
          catch (error) {
            const message = (error as Error).message;
            if (message === 'INPUT_MACRO_NAME_TAKEN') throw new ProtocolError('INPUT_CONFLICT');
            if (message === 'INPUT_MACRO_NOT_FOUND') throw new ProtocolError('INPUT_NOT_FOUND');
            throw new ProtocolError('INPUT_UNAVAILABLE');
          }
        } }),
      registry.register('input.macro.delete', { validate: p => macroIdPayloadSchema.safeParse(p).success,
        execute: async (p, context) => {
          if (!this.macros) throw new ProtocolError('INPUT_UNAVAILABLE');
          this.requireAuthorized(context);
          return { macros: this.macros.remove(macroIdPayloadSchema.parse(p).id) };
        } }),
    ];
  }

  /** Macro list/save/delete need an authenticated phone, not an active control session. */
  private requireAuthorized(context: import('../command-router/command-context.js').CommandContext): void {
    if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
  }
  async stop(): Promise<void> {
    for (const remove of this.unregister) remove();
    await this.session.stop();
  }
}
