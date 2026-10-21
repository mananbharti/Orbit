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
  LAUNCHER_UNAVAILABLE: 'The computer cannot list its apps right now.',
  SYSTEM_UNAVAILABLE: 'The computer could not do that on this system.',
  LAUNCHER_STALE_CATALOG: 'The app list changed. Refresh it and try again.',
  LAUNCHER_NOT_FOUND: 'That app is no longer available.',
  LAUNCHER_STALE_LAYOUT: 'The pinned apps changed somewhere else. Reopen Apps to see the latest.',
  LAUNCHER_SCENE_CONFLICT: 'A scene with that name already exists.',
  INPUT_CONFLICT: 'A macro with that name already exists.',
  INPUT_NOT_FOUND: 'That macro no longer exists.',
  LAUNCHER_UNKNOWN_OUTCOME: 'Not sure the app opened. Check your computer.',
  LAUNCHER_LIMIT: 'The computer has too many apps to list.',
  BUSY: 'The computer is busy. Try again in a moment.',
  PAIR_NOT_FOUND: 'That device is no longer paired.',
  PAIR_SELF_SCOPES: 'This phone cannot change its own permissions.',
  AUTOMATION_NOT_FOUND: 'That automation no longer exists.',
  AUTOMATION_LIMIT: 'The computer has too many automations. Delete one first.',
  TERMINAL_UNAVAILABLE: 'The terminal is not available on this computer.',
  TABS_EXTENSION_OFFLINE: 'Connect the Orbit browser extension on your computer first.',
  TABS_NOT_FOUND: 'That tab is already gone.',
  TERMINAL_SESSION_REQUIRED: 'Start a terminal session first.',
  BIOMETRIC_REQUIRED: 'Confirm on the computer first, then try again.',
  INPUT_UNAVAILABLE: 'Remote control is not available on this computer.',
  INPUT_SESSION_REQUIRED: 'Start remote control first.',
  CLIPBOARD_UNAVAILABLE: 'The computer clipboard is not available right now.',
  FILE_QUOTA: 'That file is too large, or too many transfers are running. Wait for one to finish.',
  FILE_IO: 'The computer could not read or save the file. Check its disk and try again.',
  FILE_INTEGRITY: 'The file did not arrive intact. Send it again.',
  FILE_SOURCE_CHANGED: 'The file changed while it was being sent. Send it again.',
  FILE_NOT_FOUND: 'That transfer no longer exists.',
  FILE_EXPIRED: 'That transfer expired. Start it again.',
  FILE_INVALID_STATE: 'That transfer has already finished or stopped.',
};

export function describeError(error: unknown): string {
  if (error instanceof CommandError) return BY_CODE[error.code] ?? 'The computer could not do that.';
  if (error instanceof OutcomeUnknown) return 'Lost connection while sending. Check the task list before trying again.';
  if (error instanceof NotSent || error instanceof PairingError) return error.message;
  if (error instanceof InvalidDesktopReply) return 'The computer sent something unexpected. Update Orbit on both devices.';
  return 'Something went wrong.';
}
