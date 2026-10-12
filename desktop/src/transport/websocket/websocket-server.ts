/** Serves WSS and credential-to-session exchange; depends on HTTPS/ws and core modules; does not enroll devices. */
import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { ActivityLog } from '../../activity-log/activity-log.js';
import type { CommandRouter } from '../../command-router/command-router.js';
import { isLocalAddress, MAX_CONNECTIONS, MAX_MESSAGE_BYTES } from '../../config.js';
import { PROTOCOL_VERSION, type JsonValue } from '../../protocol/messages.js';
import type { SessionAuth } from '../../security-pairing/session-auth.js';
import { ConnectionManager } from './connection-manager.js';
import type { PairingService } from '../../security-pairing/pairing-service.js';

export interface TransportOptions {
  tls: ServerOptions;
  host: string;
  port: number;
  router: CommandRouter;
  auth: SessionAuth;
  log: ActivityLog;
  heartbeatMs?: number;
  pairing?: PairingService;
}

function bearer(request: IncomingMessage): string {
  return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
}

export function createWebSocketTransport(options: TransportOptions) {
  if (!options.tls.cert || !options.tls.key) throw new Error('TLS certificate and private key required');
  if (!isLocalAddress(options.host)) throw new Error('Transport must bind to a local IP address');
  const connections = new ConnectionManager(options.router, options.auth, options.log, options.heartbeatMs);
  const sockets = new Set<Duplex>();
  const upgrades = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const attempts = new Map<string, { count: number; until: number }>();
  const rateWindowMs = 60_000;
  const maxAttemptsPerWindow = 60;
  let stopping = false;

  function allowed(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? '';
    // Native clients do not send Origin. Reject browser-driven LAN requests, including DNS rebinding.
    if (stopping || !isLocalAddress(address) || request.headers.origin !== undefined) return false;
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    let entry = attempts.get(address);
    if (!entry) {
      if (attempts.size >= MAX_CONNECTIONS * 4) return false;
      entry = { count: 0, until: now + rateWindowMs };
      attempts.set(address, entry);
    }
    return ++entry.count <= maxAttemptsPerWindow;
  }

  const server = createServer({ ...options.tls, minVersion: 'TLSv1.2', maxHeaderSize: 8_192 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    request.on('error', () => response.destroy());
    response.on('error', () => response.destroy());
    if (!allowed(request)) {
      response.writeHead(403).end(JSON.stringify({ version: PROTOCOL_VERSION, error: 'REJECTED' }));
      return;
    }
    if (request.method !== 'POST' || !['/v1/session', '/v1/pair'].includes(request.url ?? '')) {
      response.writeHead(404).end(JSON.stringify({ version: PROTOCOL_VERSION, error: 'NOT_FOUND' }));
      return;
    }
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] ?? '0') !== '0') {
      response.setHeader('Connection', 'close');
      response.writeHead(400).end(JSON.stringify({ version: PROTOCOL_VERSION, error: 'INVALID_REQUEST' }));
      return;
    }
    if (request.url === '/v1/pair') {
      try {
        const paired = options.pairing?.redeem(bearer(request));
        response.writeHead(paired ? 200 : 401).end(JSON.stringify(paired
          ?? { version: PROTOCOL_VERSION, error: 'PAIRING_REJECTED' }));
      } catch {
        options.log.record({ severity: 'error', eventType: 'pairing.rejected', outcome: 'failed' });
        response.writeHead(503).end(JSON.stringify({ version: PROTOCOL_VERSION, error: 'PAIRING_UNAVAILABLE' }));
      }
      return;
    }
    const issued = options.auth.issue(bearer(request));
    if (!issued) {
      options.log.record({ severity: 'warn', eventType: 'authentication.rejected', outcome: 'rejected' });
      response.writeHead(401).end(JSON.stringify({ version: PROTOCOL_VERSION, error: 'UNAUTHENTICATED' }));
      return;
    }
    response.writeHead(200).end(JSON.stringify({ version: PROTOCOL_VERSION, deviceId: issued.session.deviceId, sessionId: issued.session.sessionId,
      expiresAt: issued.session.expiresAt, sessionToken: issued.sessionToken }));
  });
  server.maxConnections = MAX_CONNECTIONS * 2;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.setTimeout(10_000, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {
    options.log.record({ severity: 'warn', eventType: 'connection.error', outcome: 'failed' });
  });
  server.on('error', () => {
    options.log.record({ severity: 'error', eventType: 'service.error', outcome: 'failed' });
  });
  upgrades.on('error', () => {
    options.log.record({ severity: 'warn', eventType: 'connection.error', outcome: 'failed' });
  });
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = () => {
      options.log.record({ severity: 'warn', eventType: 'authentication.rejected', outcome: 'rejected' });
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    if (!allowed(request) || request.url !== '/v1/channel' || connections.size >= MAX_CONNECTIONS) return reject();
    const token = bearer(request);
    const session = options.auth.authenticate(token);
    if (!session) return reject();
    try {
      upgrades.handleUpgrade(request, socket, head, ws => {
        request.socket.setTimeout(0);
        connections.attach(ws, token, session);
      });
    } catch { socket.destroy(); }
  });

  return {
    publish(deviceId: string, eventType: string, data: JsonValue): void {
      connections.publish(deviceId, eventType, data);
    },
    async start(): Promise<AddressInfo> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.host);
      });
      options.log.record({ severity: 'info', eventType: 'service.started', outcome: 'success' });
      return server.address() as AddressInfo;
    },
    async stop(): Promise<void> {
      stopping = true;
      connections.shutdown();
      const forceClose = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1_100);
      forceClose.unref();
      await Promise.all([
        new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => upgrades.close(() => resolve())),
      ]);
      clearTimeout(forceClose);
      options.log.record({ severity: 'info', eventType: 'service.stopped', outcome: 'success' });
    },
  };
}
