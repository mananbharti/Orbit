/** The dictation setup machine over the real pinned-TLS wire: the phone sees off/downloading/ready/failed honestly, retry is user-triggered, and cancel aborts a stuck download. Fake provisioning; real desktop service, registry, and phone core. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CommandRegistry } from '../../../desktop/src/command-router/command-registry.js';
import { startDesktop } from '../../../desktop/src/desktop-service.js';
import { DictationSetup, ProvisionError, type EnginePaths } from '../../../desktop/src/dictation/provision.js';
import { DictationApi } from '../../core/src/dictation.js';
import { pairWithQr } from '../../core/src/pairing.js';
import { OrbitSession } from '../../core/src/session.js';
import { NodePinnedTransport } from './node-pinned-transport.js';

const PATHS: EnginePaths = { binary: '/fake/whisper-cli', model: '/fake/ggml-tiny.bin' };
const quiet = { record: () => {} };

async function phone(t: TestContext, provision: (signal: AbortSignal) => Promise<EnginePaths>) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-phone-dsetup-'));
  const registry = new CommandRegistry();
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false, registry });
  let attached: EnginePaths | undefined;
  const setup = new DictationSetup(registry, join(root, 'data'), paths => { attached = paths; }, quiet as never,
    { auto: false, provision: o => provision(o.signal ?? new AbortController().signal) });
  const transport = new NodePinnedTransport(new Map());
  const qr = service.pairing.open();
  (transport as unknown as { certificates: Map<string, string> }).certificates.set(qr.certificateFingerprint, service.hint.certificate);
  const paired = await pairWithQr(JSON.stringify(qr), transport);
  const session = new OrbitSession(paired, transport, { uuid: randomUUID });
  t.after(async () => { setup.cancel(); session.stop(); await service.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  return { api: new DictationApi(session), setup, attached: () => attached };
}

test('the phone reads off, then a manual retry downloads and flips to ready over the wire', async t => {
  const { api, attached } = await phone(t, async () => { await new Promise(r => setTimeout(r, 30)); return PATHS; });
  assert.deepEqual(await api.setupState(), { state: 'off' });
  assert.deepEqual(await api.retrySetup(), { state: 'downloading' });
  for (let i = 0; i < 100 && (await api.setupState()).state === 'downloading'; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(await api.setupState(), { state: 'ready' });
  assert.deepEqual(attached(), PATHS);
});

test('a failed download surfaces the reason over the wire and never attaches an engine', async t => {
  const { api, attached } = await phone(t, async () => { throw new ProvisionError('HASH_MISMATCH'); });
  assert.deepEqual(await api.retrySetup(), { state: 'downloading' });
  for (let i = 0; i < 100; i++) { const s = await api.setupState(); if (s.state === 'failed') { assert.equal(s.reason, 'HASH_MISMATCH'); break; } await new Promise(r => setTimeout(r, 20)); }
  assert.equal((await api.setupState()).state, 'failed');
  assert.equal(attached(), undefined);
});

test('the phone can cancel an in-flight download and the state answers honestly', async t => {
  const { api } = await phone(t, signal => new Promise<EnginePaths>((_res, rej) => { signal.addEventListener('abort', () => rej(new ProvisionError('DOWNLOAD_FAILED', 'cancelled'))); }));
  assert.deepEqual(await api.retrySetup(), { state: 'downloading' });
  const cancelled = await api.cancelSetup();
  assert.equal(cancelled.state, 'failed');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal((await api.setupState()).state, 'failed');
});
