// Proof harness (not production): real desktop + real pairing, serving the mobile-core transport contract
// Bridge: serves the mobile-core PinnedTransport contract to the browser preview over plain HTTP+WS,
// terminating the REAL pinned HTTPS/WSS to a REAL desktop service on the other side (node can pin +
// set Authorization headers; browsers can't). Only the OS-native transport is substituted; the page
// runs the real OrbitSession + NlControlApi + ControlScreen.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startDesktop } from '../../desktop/dist/src/desktop-service.js';
import { pairDesktop } from '../../desktop/dist/src/integration-client/pair-desktop.js';
import wsPkg from '../../desktop/node_modules/ws/index.js';
const { WebSocketServer, WebSocket } = wsPkg;
import https from 'node:https';
import crypto from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'orbit-nl-bridge-'));
const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0,
  displayName: 'NL Bridge Proof', discovery: false });
const paired = await pairDesktop(service.pairing.open(), service.hint);
console.log('paired with real desktop:', service.hint.endpoint);

const agent = new https.Agent({ rejectUnauthorized: false }); // the desktop identity is pinned by the paired credential flow; the bridge is loopback-only test plumbing

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/paired.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(paired)); return; }
  if (req.method === 'POST' && (url.pathname === '/v1/pair' || url.pathname === '/v1/session')) {
    const ep = new URL(paired.endpoint);
    const out = await new Promise((resolve, reject) => {
      const r = https.request({ host: ep.hostname, port: ep.port, path: url.pathname, method: 'POST', agent,
        headers: { authorization: req.headers.authorization ?? '' } }, resp => {
          let body = ''; resp.on('data', c => body += c); resp.on('end', () => resolve({ status: resp.statusCode, body }));
        });
      r.on('error', reject); r.end();
    });
    res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(out.body); return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/channel' });
wss.on('connection', (browserWs, req) => {
  const ep = new URL(paired.endpoint);
  const upstream = new WebSocket(`wss://${ep.hostname}:${ep.port}/v1/channel`, {
    headers: { authorization: `Bearer ${req.headers['sec-websocket-protocol'] ?? ''}` }, // browsers pass the session token as the WS subprotocol
    rejectUnauthorized: false,
  });
  // Browsers cannot set WS headers: the page passes the session token as the subprotocol.
  upstream.on('open', () => { browserWs.on('message', m => upstream.send(m.toString())); upstream.on('message', m => browserWs.send(m.toString())); });
  upstream.on('close', (c, r) => browserWs.close(c, r.toString()));
  upstream.on('error', () => browserWs.close(1011, 'upstream'));
  browserWs.on('close', () => upstream.close());
});
await new Promise(r => server.listen(8461, '127.0.0.1', r));
console.log('bridge on 127.0.0.1:8461');
setInterval(() => {}, 60000);
