/** Turns errors into short sentences a person can act on; depends on session error types; never exposes codes or internals. */
import { CommandError, NotSent, OutcomeUnknown } from './session.js';
import { PairingError } from './pairing.js';
import { InvalidDesktopReply } from './agent.js';

const BY_CODE: Partial<Record<string, string>> = {
  AGENT_PAUSED: 'The agent is stopped. Resume it first.',
  SCOPE_DENIED: 'This phone is not allowed to do that. Pair again with more permissions.',
  AGENT_LIMIT: 'Too many tasks are running. Wait for one to finish.',
  AGENT_NOT_FOUND: 'That task no longer exists.',
  AGENT_INVALID_STATE: 'That task has already moved on.',
  AGENT_LEDGER_IO: 'The computer could not save the task. Check its disk.',
  UNAUTHENTICATED: 'This phone is not signed in to the computer. Pair again.',
  BUSY: 'The computer is busy. Try again in a moment.',
};

export function describeError(error: unknown): string {
  if (error instanceof CommandError) return BY_CODE[error.code] ?? 'The computer could not do that.';
  if (error instanceof OutcomeUnknown) return 'Lost connection while sending. Check the task list before trying again.';
  if (error instanceof NotSent || error instanceof PairingError) return error.message;
  if (error instanceof InvalidDesktopReply) return 'The computer sent something unexpected. Update Orbit on both devices.';
  return 'Something went wrong.';
}
