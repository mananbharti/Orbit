/** Panic lock: one command locks the workstation and unpairs the calling phone; depends on the credential store and (optionally) system control; the lock is best-effort, the unpair always runs. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import type { CommandRegistry } from '../command-router/command-registry.js';
import type { CommandContext } from '../command-router/command-context.js';
import type { SystemControlAdapter } from '../os-integration/system-control.js';
import { ProtocolError } from '../protocol/errors.js';
import { emptySystemSchema } from '../protocol/system-control.js';
import type { FilePairedCredentialStore } from './paired-credential-store.js';

export class PanicLock {
  private readonly unregister: () => void;

  constructor(registry: CommandRegistry, private readonly credentials: FilePairedCredentialStore,
    private readonly createLockAdapter: (() => SystemControlAdapter) | undefined, private readonly log: ActivityLog,
    private readonly onRevoked: () => void = () => undefined) {
    this.unregister = registry.register('system.panic', {
      validate: payload => emptySystemSchema.safeParse(payload).success,
      execute: (_payload, context) => this.panic(context),
    });
  }

  stop(): void { this.unregister(); }

  private async panic(context: CommandContext): Promise<{ status: 'locked' | 'unpaired' }> {
    if (!context.connection?.isAuthorized()) throw new ProtocolError('UNAUTHENTICATED');
    const deviceId = context.session.deviceId;
    // Lock first, best effort: a machine that cannot lock still loses the phone.
    let locked = false;
    try {
      if (!this.createLockAdapter) throw new Error('no lock adapter on this platform');
      await this.createLockAdapter().power('lock'); locked = true;
    } catch { /* the unpair still runs */ }
    // The reply must reach the phone first: revoking closes the socket before the response frame is written, so the unpair lands a tick after dispatch returns.
    setTimeout(() => {
      const unpaired = this.credentials.revoke(deviceId);
      this.onRevoked();
      this.log.record({ severity: 'warn', eventType: 'system.panic', outcome: unpaired ? 'success' : 'failed', deviceId });
    }, 25).unref();
    return { status: locked ? 'locked' : 'unpaired' };
  }
}
