/** Device management over the wire: list paired devices and change what each may do; depends on the registry and the credential store. */
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import { ProtocolError } from '../protocol/errors.js';
import type { JsonValue } from '../protocol/messages.js';
import { revokeDeviceSchema, setDeviceScopesSchema } from '../protocol/pairing.js';
import type { Scope } from './scopes.js';
import type { FilePairedCredentialStore } from './paired-credential-store.js';

// The 'pair' command family is deliberately absent from FAMILY_SCOPE: only full-access devices may manage devices (fail closed).
export class DeviceDirectory {
  private readonly unregister: (() => void)[];

  constructor(registry: CommandRegistry, private readonly store: FilePairedCredentialStore,
    private readonly onRevoked: () => void = () => undefined) {
    this.unregister = [
      registry.register('pair.devices', { validate: p => p === null || (typeof p === 'object' && Object.keys(p).length === 0),
        execute: async (_p, context) => {
          this.authorize(context);
          return this.current(context.session.deviceId);
        } }),
      registry.register('pair.scopes.set', { validate: p => setDeviceScopesSchema.safeParse(p).success,
        execute: async (p, context) => {
          this.authorize(context);
          const { deviceId, scopes } = setDeviceScopesSchema.parse(p);
          if (deviceId === context.session.deviceId) throw new ProtocolError('PAIR_SELF_SCOPES'); // a phone must never lock itself out mid-session
          if (!this.store.setScopes(deviceId, scopes === 'all' ? undefined : scopes as Scope[])) throw new ProtocolError('PAIR_NOT_FOUND');
          return this.current(context.session.deviceId);
        } }),
      registry.register('pair.revoke', { validate: p => revokeDeviceSchema.safeParse(p).success,
        execute: async (p, context) => {
          this.authorize(context);
          const { deviceId } = revokeDeviceSchema.parse(p);
          if (deviceId === context.session.deviceId) {
            // The reply must reach the phone first: revoking closes the socket before the response frame is written,
            // so a phone unpairing itself lands a tick after dispatch returns (same pattern as panic lock).
            setTimeout(() => { this.store.revoke(deviceId); this.onRevoked(); }, 25).unref();
            return { current: context.session.deviceId, devices: this.store.list().filter(d => d.deviceId !== deviceId)
              .map(d => ({ deviceId: d.deviceId, scopes: d.scopes === 'all' ? 'all' : [...d.scopes] })) } as unknown as JsonValue;
          }
          if (!this.store.revoke(deviceId)) throw new ProtocolError('PAIR_NOT_FOUND');
          this.onRevoked();
          return this.current(context.session.deviceId);
        } }),
    ];
  }
  stop(): void { for (const unregister of this.unregister) unregister(); }

  private current(deviceId: string): JsonValue {
    const devices = this.store.list().map(d => ({ deviceId: d.deviceId, scopes: d.scopes === 'all' ? 'all' : [...d.scopes] }));
    return { current: deviceId, devices } as unknown as JsonValue;
  }

  private authorize(context: CommandContext): void {
    if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
  }
}
