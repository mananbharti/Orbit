/** Exercises File Transfer through real pairing/WSS and disk checkpoints; depends on isolated synthetic files; never reads user data or native clipboards. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../src/desktop-service.js';
import { OrbitClient, RENEW_AFTER_COMMANDS } from '../src/integration-client/orbit-client.js';
import { FileClient } from '../src/integration-client/file-client.js';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { privateDirectory } from '../src/security-pairing/private-directory.js';
import { MemoryClipboard, waitForClipboard as waitFor } from './clipboard-helpers.js';
import { CHUNK_BYTES } from '../src/protocol/file-transfer.js';

async function fixture(t: TestContext, ttlMs = 300_000) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-file-wss-'));
  const clipboard = new MemoryClipboard();
  const options = { directory: join(root, 'service'), host: '127.0.0.1', port: 0, displayName: 'Orbit File Test',
    discovery: false, sessionTtlMs: ttlMs, clipboard: { createAdapter: () => clipboard, pollMs: 10 } };
  const service = await startDesktop(options);
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const directory = privateDirectory(join(root, 'client'));
  const client = new OrbitClient(paired);
  const files = new FileClient(client, directory, paired.desktopServiceId);
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    client.stop(); await files.stop();
    for (const done of cleanup) await done();
    await service.stop(); rmSync(root, { recursive: true, force: true });
  });
  await client.start();
  return { root, options, service, client, files, paired, directory, clipboard, cleanup };
}

test('upload and zero-byte files complete over WSS while Clipboard Sync keeps a live command slot', { timeout: 30_000 }, async t => {
  const { root, client, files, service, clipboard, cleanup } = await fixture(t);
  const local = new MemoryClipboard();
  const bridge = new ClipboardClient(client, local, 10);
  cleanup.push(() => bridge.stop());
  let active = false; bridge.on('status', status => { if (status === 'active') active = true; });
  await waitFor(() => active);
  const bytes = Buffer.alloc(CHUNK_BYTES * 8 + 13, 37);
  const path = join(root, 'upload.bin'); writeFileSync(path, bytes);
  const id = await files.upload(path);
  local.value = { kind: 'text', text: 'clipboard during file transfer' };
  await waitFor(() => files.store.records.get(id)?.state === 'completed', 15_000);
  await waitFor(() => clipboard.writes.length > 0);
  const row = service.files.store.records.get(id)!;
  assert.deepEqual(readFileSync(service.files.store.paths(row).destination), bytes);
  const empty = join(root, 'empty.bin'); writeFileSync(empty, Buffer.alloc(0));
  const emptyId = await files.upload(empty);
  await waitFor(() => files.store.records.get(emptyId)?.state === 'completed', 15_000);
  assert.equal(readFileSync(service.files.store.paths(service.files.store.records.get(emptyId)!).destination).length, 0);
});

test('client process restart reconciles an accepted download from its durable prefix', { timeout: 40_000 }, async t => {
  const { root, files, service, client, paired, directory, cleanup } = await fixture(t);
  const bytes = Buffer.alloc(CHUNK_BYTES * 12 + 19, 61);
  const source = join(root, 'selected.bin'); writeFileSync(source, bytes);
  const offer = await service.files.offerLocal(source, paired.deviceId);
  assert.equal((await files.offers())[0]?.transferId, offer.transferId);
  let interrupted = false;
  files.on('status', status => {
    if (!interrupted && status.committedBytes >= CHUNK_BYTES * 2) { interrupted = true; client.stop(); }
  });
  await files.download(offer.transferId);
  await waitFor(() => interrupted);
  await files.stop();
  const secondClient = new OrbitClient(paired);
  const secondFiles = new FileClient(secondClient, directory, paired.desktopServiceId);
  cleanup.push(async () => { secondClient.stop(); await secondFiles.stop(); });
  await secondClient.start();
  await waitFor(() => secondFiles.store.records.get(offer.transferId)?.state === 'completed', 15_000);
  assert.deepEqual(readFileSync(secondFiles.store.paths(secondFiles.store.records.get(offer.transferId)!).destination), bytes);
});

test('desktop process restart resumes an upload without changing transfer identity', { timeout: 40_000 }, async t => {
  const { root, files, service, options, client, cleanup } = await fixture(t);
  const source = join(root, 'restart.bin'); const bytes = Buffer.alloc(CHUNK_BYTES * 16 + 1, 19); writeFileSync(source, bytes);
  let stopping: Promise<void> | undefined;
  files.on('status', status => { if (!stopping && status.committedBytes >= CHUNK_BYTES * 2) stopping = service.stop(); });
  const id = await files.upload(source);
  await waitFor(() => !!stopping);
  await stopping;
  const restarted = await startDesktop({ ...options, port: Number(new URL(service.hint.endpoint).port),
    clipboard: { createAdapter: () => new MemoryClipboard(), pollMs: 10 } });
  cleanup.push(() => restarted.stop());
  await waitFor(() => client.connected && files.store.records.get(id)?.state === 'completed', 15_000);
  assert.deepEqual(readFileSync(restarted.files.store.paths(restarted.files.store.records.get(id)!).destination), bytes);
});

test('3,000 submitted commands force authenticated renewal before another request is sent', { timeout: 40_000 }, async t => {
  const { client, service, files } = await fixture(t);
  await client.scheduledCommand('file.offers', {});
  await files.stop();
  let connections = 0; client.on('status', status => { if (status === 'connected') connections++; });
  // The file harness already sent its initial subscription; use its session's actual command log count.
  let count = service.log.snapshot().filter(event => event.eventType === 'command.completed').length;
  while (count++ < RENEW_AFTER_COMMANDS) assert.ok((await client.scheduledCommand('file.offers', {})).payload.ok);
  await assert.rejects(client.scheduledCommand('file.offers', {}), /renewing|changed|not sent/);
  await waitFor(() => connections === 1 && client.connected);
  assert.ok((await client.command('file.offers', {})).payload.ok);
});

test('a lost completion receipt is recovered even if the original upload source was removed', { timeout: 30_000 }, async t => {
  const { root, files, client, paired, directory, cleanup } = await fixture(t);
  const source = join(root, 'completed.bin'); writeFileSync(source, 'synthetic delivered data');
  const id = await files.upload(source);
  await waitFor(() => files.store.records.get(id)?.state === 'completed');
  client.stop(); await files.stop();
  const checkpoint = files.store.records.get(id)!;
  checkpoint.state = 'paused'; files.store.save(checkpoint);
  unlinkSync(source);
  const nextClient = new OrbitClient(paired); const nextFiles = new FileClient(nextClient, directory, paired.desktopServiceId);
  cleanup.push(async () => { nextClient.stop(); await nextFiles.stop(); });
  await nextClient.start();
  await waitFor(() => nextFiles.store.records.get(id)?.state === 'completed');
});

test('an upload crosses proactive renewal and reconciles its checkpoint on the new lease', { timeout: 40_000 }, async t => {
  const { root, files, client, service } = await fixture(t);
  await client.scheduledCommand('file.offers', {});
  let count = service.log.snapshot().filter(event => event.eventType === 'command.completed').length;
  while (count++ < RENEW_AFTER_COMMANDS - 8) assert.ok((await client.scheduledCommand('file.offers', {})).payload.ok);
  let renewed = false;
  client.on('status', status => { if (status === 'connected') renewed = true; });
  const bytes = Buffer.alloc(CHUNK_BYTES * 16 + 3, 49);
  const source = join(root, 'renewal.bin'); writeFileSync(source, bytes);
  const id = await files.upload(source);
  await waitFor(() => files.store.records.get(id)?.state === 'completed', 15_000);
  assert.equal(renewed, true);
  const row = service.files.store.records.get(id)!;
  assert.deepEqual(readFileSync(service.files.store.paths(row).destination), bytes);
});
