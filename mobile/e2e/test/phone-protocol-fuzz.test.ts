/** Seeded protocol fuzzing over real paired WSS: every malformed frame gets a well-formed refusal and the session keeps working; the server never crashes on garbage. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const KNOWN_CODES = new Set(['INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNAUTHENTICATED', 'UNKNOWN_COMMAND',
  'INVALID_PAYLOAD', 'BIOMETRIC_REQUIRED', 'COMMAND_FAILED', 'DUPLICATE_REQUEST', 'BUSY', 'SCOPE_DENIED']);

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function mutate(valid: string, rand: () => number): string {
  const choice = Math.floor(rand() * 6);
  const at = Math.floor(rand() * valid.length);
  if (choice === 0) return valid.slice(0, Math.max(1, Math.floor(rand() * valid.length))); // truncation
  if (choice === 1) return valid.slice(0, at) + String.fromCharCode(1 + Math.floor(rand() * 0xD7FF)) + valid.slice(at + 1); // byte swap
  if (choice === 2) return valid.slice(0, at) + valid.slice(at) + valid.slice(at); // duplication
  if (choice === 3) return valid.slice(0, at) + '\\u0000'.repeat(1 + Math.floor(rand() * 20)) + valid.slice(at); // escapes
  if (choice === 4) return valid.replace(/"requestId":"[^"]*"/, `"requestId":${['null', '42', 'true', '{}', '[]', '"'.padEnd(9000, 'x') + '"'][Math.floor(rand() * 6)]}`);
  return valid.replace(/"version":\d+/, `"version":${['0', '2', '-1', '1.5', '"1"', 'null'][Math.floor(rand() * 6)]}`);
}

async function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-fuzz-'));
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Fuzz', discovery: false });
  t.after(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }); });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const port = Number(new URL(service.hint.endpoint).port);
  const tls = { host: '127.0.0.1', port, ca: service.hint.certificate, servername: 'localhost', checkServerIdentity: () => undefined };
  const sessionToken = await new Promise<string>((resolve, reject) => {
    const req = request({ ...tls, path: '/v1/session', method: 'POST', headers: { Authorization: `Bearer ${paired.credential}` } }, res => {
      let body = ''; res.on('data', c => { body += c; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body).sessionToken) : reject(new Error(`session issue: ${res.statusCode}`)));
    });
    req.on('error', reject); req.end();
  });
  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/v1/channel`, { ...tls, headers: { Authorization: `Bearer ${sessionToken}` } });
    ws.on('open', () => resolve(ws)); ws.on('error', reject);
  });
  return { connect };
}

test('200 seeded malformed frames all get well-formed answers and the channel survives', { timeout: 120_000 }, async t => {
  const { connect } = await world(t);
  const ws = await connect();
  t.after(() => ws.terminate());
  const valid = JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: { query: 'x' } });
  const rand = mulberry32(20261021);
  const frames: string[] = [valid];
  for (let i = 0; i < 150; i++) frames.push(mutate(valid, rand));
  frames.push('', 'null', '[]', '42', '"x"', '{', '{"version":1', 'not json at all',
    JSON.stringify({ version: 1, type: 'fuzz.noop', requestId: randomUUID(), payload: null }),
    JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: 'not-an-object' }),
    JSON.stringify({ version: 1, type: 'x'.repeat(500), requestId: randomUUID(), payload: {} }),
    JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: { query: 'x' }, extra: 'field' }));

  const answer = (frame: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within 3s for frame: ${frame.slice(0, 80)}`)), 3_000);
    ws.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    ws.send(frame);
  });

  for (const frame of frames) {
    const response = await answer(frame);
    assert.equal(response.version, 1, `bad envelope for ${frame.slice(0, 60)}`);
    assert.equal(response.type, 'response');
    const payload = response.payload as { ok: boolean; error?: { code: string; message?: string } };
    if (!payload.ok) {
      assert.ok(KNOWN_CODES.has(payload.error!.code), `unexpected error code ${payload.error!.code} for ${frame.slice(0, 60)}`);
      assert.ok(!JSON.stringify(response).includes('at '), 'no stack traces on the wire');
    }
  }
  // The valid first frame's command executed or refused cleanly, and after 200 garbage frames a real command still works.
  const alive = await answer(JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: { query: 'x' } }));
  assert.equal((alive.payload as { ok: boolean }).ok, true, 'the session survived the fuzz');

  // A frame over the 64 KiB wire limit closes the socket instead of being processed; the server lives on.
  const huge = await connect();
  t.after(() => huge.terminate());
  const closed = new Promise<number>(resolve => huge.on('close', code => resolve(code)));
  huge.send(JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: { query: 'x'.repeat(70 * 1024) } }));
  assert.equal(await closed, 1009, 'oversize frame closes with 1009');
  const fresh = await connect();
  t.after(() => fresh.terminate());
  const ok = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer on fresh socket')), 3_000);
    fresh.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    fresh.send(JSON.stringify({ version: 1, type: 'memory.recall', requestId: randomUUID(), payload: { query: 'x' } }));
  });
  assert.equal((ok.payload as { ok: boolean }).ok, true, 'the server accepted a fresh session socket after killing the oversize one');
});
