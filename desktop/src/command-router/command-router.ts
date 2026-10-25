/** Dispatches authenticated commands; depends on registry, sessions, biometric hook and log; does not implement features. */
import type { ActivityLog } from '../activity-log/activity-log.js';
import { failure, success, type CommandMessage, type ResponseMessage } from '../protocol/messages.js';
import { isSensitiveCommand, requireBiometricConfirmation, type BiometricConfirmation } from '../security-pairing/biometric-confirmation.js';
import type { Session, SessionAuth } from '../security-pairing/session-auth.js';
import type { CommandRegistry } from './command-registry.js';
import type { CommandConnection } from './command-context.js';
import { ProtocolError } from '../protocol/errors.js';
import { isCommandAllowed } from '../security-pairing/scopes.js';

export class CommandRouter {
  private readonly requests = new Map<string, { expiresAt: number; ids: Set<string> }>();
  constructor(private readonly registry: CommandRegistry, private readonly auth: SessionAuth,
    private readonly log: ActivityLog, private readonly biometric: BiometricConfirmation = requireBiometricConfirmation) {}

  async dispatch(message: CommandMessage, sessionToken: string, connection?: CommandConnection): Promise<ResponseMessage> {
    const session = this.auth.authenticate(sessionToken);
    if (!session) {
      this.log.record({ severity: 'warn', eventType: 'authentication.rejected',
        requestId: message.requestId, outcome: 'rejected' });
      return failure(message.requestId, 'UNAUTHENTICATED');
    }
    for (const [id, entry] of this.requests) if (entry.expiresAt <= Date.now()) this.requests.delete(id);
    let requests = this.requests.get(session.sessionId);
    if (!requests) {
      if (this.requests.size >= 128) return failure(message.requestId, 'BUSY');
      requests = { expiresAt: session.expiresAt, ids: new Set() };
      this.requests.set(session.sessionId, requests);
    }
    if (requests.ids.has(message.requestId)) return failure(message.requestId, 'DUPLICATE_REQUEST');
    // Never evict IDs while a session is valid: a retry could otherwise repeat a sensitive operation.
    if (requests.ids.size >= 4_096) return failure(message.requestId, 'BUSY');
    requests.ids.add(message.requestId);
    return this.dispatchAuthorized(message, session, connection, sessionToken);
  }

  /** Dispatches a command for an already-authenticated session - the same scope, duplicate-safe and
   *  sensitive-command enforcement as dispatch(), without re-authenticating a token. Trusted callers
   *  inside the desktop (e.g. natural-language control) synthesize sub-commands through this so a
   *  mapped command can never bypass the gates a directly-sent command would face. */
  async dispatchAuthorized(message: CommandMessage, session: Session, connection?: CommandConnection, sessionToken?: string): Promise<ResponseMessage> {
    const handler = this.registry.get(message.type);
    let response: ResponseMessage;
    try {
      if (!handler) response = failure(message.requestId, 'UNKNOWN_COMMAND');
      else if (!isCommandAllowed(session.scopes, message.type)) response = failure(message.requestId, 'SCOPE_DENIED');
      else if (!handler.validate(message.payload)) response = failure(message.requestId, 'INVALID_PAYLOAD');
      else {
        const context = { session, requestId: message.requestId, connection };
        if (isSensitiveCommand(message.type) && !await this.biometric.verify(message, context)) {
          response = failure(message.requestId, 'BIOMETRIC_REQUIRED');
        } else if (sessionToken ? !this.auth.authenticate(sessionToken) : !this.auth.isLive(session)) {
          // Verification may have awaited user interaction past session expiry.
          response = failure(message.requestId, 'UNAUTHENTICATED');
        } else response = success(message.requestId, await handler.execute(message.payload, context));
      }
    } catch (error) { response = failure(message.requestId, error instanceof ProtocolError ? error.code : 'COMMAND_FAILED'); }
    this.log.record({ severity: response.payload.ok ? 'info' : 'warn', eventType: 'command.completed',
      deviceId: session.deviceId, sessionId: session.sessionId, requestId: message.requestId,
      commandType: handler ? message.type : undefined, outcome: response.payload.ok ? 'success'
        : response.payload.error.code === 'COMMAND_FAILED' ? 'failed' : 'rejected' });
    return response;
  }
}
