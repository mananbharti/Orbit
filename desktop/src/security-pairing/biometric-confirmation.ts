/** Defines the sensitive-action verification hook; depends on command/session types; does not trust a client boolean. */
import type { CommandContext } from '../command-router/command-context.js';
import type { CommandMessage } from '../protocol/messages.js';

export interface BiometricConfirmation {
  verify(message: CommandMessage, context: CommandContext): Promise<boolean>;
}

export const requireBiometricConfirmation: BiometricConfirmation = { verify: async () => false };
export function isSensitiveCommand(type: string): boolean {
  // input.* is gated once per session by InputControlSession (confirmation at input.begin, then a lease on every call); confirming each pointer event would be unusable.
  // The registered power command is named system.power - a bare 'power.' prefix never matched it, which left power control ungated.
  return type.startsWith('power.') || type === 'system.power';
}
