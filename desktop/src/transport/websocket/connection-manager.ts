/** Maintains authenticated sockets and heartbeats; depends on ws, router and sessions; never retries feature commands. */
import { WebSocket, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import type { CommandConnection } from '../../command-router/command-context.js';
import type { ActivityLog } from '../../activity-log/activity-log.js';
import type { CommandRouter } from '../../command-router/command-router.js';
import { HEARTBEAT_INTERVAL_MS, MAX_BUFFERED_BYTES } from '../../config.js';
import { ProtocolError } from '../../protocol/errors.js';
import { failure, type EventMessage, type JsonValue, type ResponseMessage } from '../../protocol/messages.js';
import { COMMAND_PATTERN, parseMessage } from '../../protocol/validation.js';
import type { Session, SessionAuth } from '../../security-pairing/session-auth.js';

const CLOSE_GRACE_MS = 1_000;
interface Connection {
  token: string;
  session: Session;
  alive: boolean;
  busy: boolean;
  abort: AbortController;
  binding: CommandConnection;
  expiryTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
}

export class ConnectionManager {
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly router: CommandRouter, private readonly auth: SessionAuth,
    private readonly log: ActivityLog, heartbeatMs = HEARTBEAT_INTERVAL_MS) {
    this.heartbeat = setInterval(() => this.checkConnections(), heartbeatMs);
    this.heartbeat.unref();
  }

  get size(): number { return this.connections.size; }

  attach(socket: WebSocket, token: string, session: Session): void {
    const abort = new AbortController();
    const binding: CommandConnection = { id: randomUUID(), closed: abort.signal,
      isAuthorized: () => !abort.signal.aborted && socket.readyState === WebSocket.OPEN && !!this.auth.authenticate(token),
      publish: (eventType, data) => {
        if (!COMMAND_PATTERN.test(eventType) || eventType.length > 64) throw new Error('Invalid event type');
        if (binding.isAuthorized()) this.send(socket, connection,
          { version: 1, type: 'event', requestId: null, payload: { eventType, data } });
      } };
    const connection: Connection = { token, session, alive: true, busy: false, abort, binding };
    this.connections.set(socket, connection);
    this.scheduleExpiry(socket, connection);
    this.record(connection, 'connection.opened', 'success');
    socket.on('pong', () => { connection.alive = true; });
    socket.on('error', () => {
      this.record(connection, 'connection.error', 'failed');
      socket.terminate();
    });
    socket.on('close', code => {
      abort.abort();
      clearTimeout(connection.expiryTimer);
      clearTimeout(connection.closeTimer);
      this.connections.delete(socket);
      this.record(connection, 'connection.closed', code === 1000 || code === 1001 ? 'success' : 'failed');
    });
    socket.on('message', (data, binary) => {
      void this.receive(socket, connection, data, binary).catch(() => {
        this.record(connection, 'connection.error', 'failed');
        this.close(socket, connection, 1011, 'Connection failed');
      });
    });
  }

  shutdown(): void {
    clearInterval(this.heartbeat);
    for (const [socket, connection] of this.connections) this.close(socket, connection, 1001, 'Service stopping');
  }

  publish(deviceId: string, eventType: string, data: JsonValue): void {
    if (!COMMAND_PATTERN.test(eventType) || eventType.length > 64) throw new Error('Invalid event type');
    for (const [socket, connection] of this.connections) {
      if (connection.session.deviceId === deviceId) {
        this.send(socket, connection, { version: 1, type: 'event', requestId: null, payload: { eventType, data } });
      }
    }
  }

  private async receive(socket: WebSocket, connection: Connection, data: RawData, binary: boolean): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!this.auth.authenticate(connection.token)) {
      this.record(connection, 'authentication.rejected', 'rejected');
      this.close(socket, connection, 4001, 'Session expired or revoked');
      return;
    }
    let message;
    try {
      if (binary) throw new ProtocolError('INVALID_MESSAGE');
      message = parseMessage(data.toString());
    } catch (error) {
      this.record(connection, 'message.rejected', 'rejected');
      this.send(socket, connection, failure(null, error instanceof ProtocolError ? error.code : 'INVALID_MESSAGE'));
      return;
    }
    if (connection.busy) {
      this.send(socket, connection, failure(message.requestId, 'BUSY'));
      return;
    }
    if (message.type === 'session.refresh') {
      this.send(socket, connection, failure(message.requestId, 'UNKNOWN_COMMAND'));
      return;
    }
    connection.busy = true;
    try { this.send(socket, connection, await this.router.dispatch(message, connection.token, connection.binding)); }
    finally { connection.busy = false; }
  }

  private send(socket: WebSocket, connection: Connection, response: ResponseMessage | EventMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!this.auth.authenticate(connection.token)) {
      this.close(socket, connection, 4001, 'Session expired or revoked');
      return;
    }
    let serialized: string;
    try { serialized = JSON.stringify(response); }
    catch { serialized = JSON.stringify(failure(response.requestId, 'COMMAND_FAILED')); }
    if (socket.bufferedAmount + Buffer.byteLength(serialized) > MAX_BUFFERED_BYTES) {
      this.close(socket, connection, 1013, 'Client too slow');
      return;
    }
    socket.send(serialized, error => {
      if (error) {
        this.record(connection, 'connection.error', 'failed');
        socket.terminate();
      }
    });
  }

  private scheduleExpiry(socket: WebSocket, connection: Connection): void {
    clearTimeout(connection.expiryTimer);
    connection.expiryTimer = setTimeout(() => {
      this.record(connection, 'authentication.rejected', 'rejected');
      this.close(socket, connection, 4001, 'Session expired or revoked');
    }, Math.max(1, connection.session.expiresAt - Date.now()));
    connection.expiryTimer.unref();
  }

  private checkConnections(): void {
    for (const [socket, connection] of this.connections) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!this.auth.authenticate(connection.token)) {
        this.close(socket, connection, 4001, 'Session expired or revoked');
      } else if (!connection.alive) {
        this.record(connection, 'connection.timeout', 'failed');
        socket.terminate();
      } else {
        connection.alive = false;
        socket.ping(undefined, false, error => {
          if (error) socket.terminate();
        });
      }
    }
  }

  private close(socket: WebSocket, connection: Connection, code: number, reason: string): void {
    if (connection.closeTimer) return;
    connection.abort.abort();
    socket.close(code, reason);
    connection.closeTimer = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
    connection.closeTimer.unref();
  }

  private record(connection: Connection, eventType: Parameters<ActivityLog['record']>[0]['eventType'],
    outcome: 'success' | 'rejected' | 'failed'): void {
    this.log.record({ severity: outcome === 'success' ? 'info' : 'warn', eventType,
      deviceId: connection.session.deviceId, sessionId: connection.session.sessionId, outcome });
  }
}
