/** Carries verified dispatch identity; depends on session types; never carries the credential or session token. */
import type { Session } from '../security-pairing/session-auth.js';
import type { JsonValue } from '../protocol/messages.js';

/** A transport-owned capability for one socket; client payloads cannot supply this identity. */
export interface CommandConnection {
  readonly id: string;
  readonly closed: AbortSignal;
  isAuthorized(): boolean;
  publish(eventType: string, data: JsonValue): void;
}

export interface CommandContext {
  session: Session;
  requestId: string;
  connection?: CommandConnection;
}
