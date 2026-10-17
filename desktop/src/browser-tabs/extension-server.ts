/** Loopback-only WebSocket channel between the desktop app and the Orbit browser extension. Never binds a LAN address. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ExtensionRequest { id: string; type: string; [key: string]: unknown }
export interface ExtensionResponse { id: string; ok: boolean; result?: unknown; error?: string }

interface LoopbackKeys { port: number; token: string }

const REQUEST_TIMEOUT_MS = 5_000;

function loadOrCreateKeys(dir: string): LoopbackKeys {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'browser-extension.json');
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LoopbackKeys>;
      if (typeof parsed.port === 'number' && parsed.port > 1024 && parsed.port < 65536 && typeof parsed.token === 'string' && parsed.token.length >= 16)
        return { port: parsed.port, token: parsed.token };
    }
  } catch { /* corrupt file: regenerate below */ }
  const keys: LoopbackKeys = { port: 17300 + Math.floor(Math.random() * 400), token: randomBytes(18).toString('base64url') };
  const tmp = join(dir, '.browser-extension.tmp');
  writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return keys;
}

/** Owns the extension connection: at most one extension at a time; a newer connection replaces the older one. */
export class ExtensionServer {
  private http?: Server;
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private nextId = 1;
  private readonly inflight = new Map<string, { resolve: (r: ExtensionResponse) => void; timer: NodeJS.Timeout }>();
  private readonly keys: LoopbackKeys;

  constructor(dir: string, private readonly onConnection?: (connected: boolean) => void) {
    this.keys = loadOrCreateKeys(dir);
  }

  get port(): number { return this.keys.port; }
  get token(): string { return this.keys.token; }
  get extensionConnected(): boolean { return this.client?.readyState === WebSocket.OPEN; }

  async start(): Promise<void> {
    if (this.http) return;
    this.http = createServer((_req, res) => { res.writeHead(404).end(); });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on('connection', (socket, req) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.searchParams.get('token') !== this.keys.token) { socket.close(4001, 'bad token'); return; }
      this.attach(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.http!;
      server.once('error', reject);
      server.listen(this.keys.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const bound = this.http.address() as AddressInfo;
    if (bound.port !== this.keys.port) this.keys.port = bound.port; // tolerate the persisted port being taken
  }

  private attach(socket: WebSocket): void {
    this.client?.close(4000, 'replaced');
    this.client = socket;
    this.onConnection?.(true);
    socket.on('message', (raw: RawData) => {
      let message: ExtensionResponse;
      try { message = JSON.parse(String(raw)) as ExtensionResponse; } catch { return; }
      if (typeof message.id !== 'string') return;
      const waiter = this.inflight.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.inflight.delete(message.id);
      waiter.resolve(message);
    });
    socket.on('close', () => {
      if (this.client !== socket) return;
      this.client = undefined;
      for (const [id, waiter] of this.inflight) { clearTimeout(waiter.timer); waiter.resolve({ id, ok: false, error: 'disconnected' }); }
      this.inflight.clear();
      this.onConnection?.(false);
    });
  }

  /** Sends a request to the extension; resolves ok:false on timeout or disconnect instead of throwing. */
  request(type: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
    const socket = this.client;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.resolve({ id: '', ok: false, error: 'extension not connected' });
    const id = `ext-${this.nextId++}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.inflight.delete(id); resolve({ id, ok: false, error: 'timeout' }); }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.inflight.set(id, { resolve, timer });
      socket.send(JSON.stringify({ id, type, ...payload } satisfies ExtensionRequest));
    });
  }

  async stop(): Promise<void> {
    this.client?.close(4000, 'shutdown');
    this.client = undefined;
    for (const [id, waiter] of this.inflight) { clearTimeout(waiter.timer); waiter.resolve({ id, ok: false, error: 'shutdown' }); }
    this.inflight.clear();
    await new Promise<void>(resolve => { this.wss?.close(() => resolve()); });
    await new Promise<void>(resolve => { this.http?.close(() => resolve()); });
    this.wss = undefined;
    this.http = undefined;
  }
}
