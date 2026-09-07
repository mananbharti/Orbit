/** Tests App Launcher over real paired WSS with other modules; depends on synthetic activation and temporary files; never opens installed applications. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startDesktop } from '../src/desktop-service.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import { LauncherClient } from '../src/integration-client/launcher-client.js';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import { FileClient } from '../src/integration-client/file-client.js';
import { privateDirectory } from '../src/security-pairing/private-directory.js';
import { MemoryClipboard, waitForClipboard as waitFor } from './clipboard-helpers.js';

async function fixture(t: TestContext, sessionTtlMs = 300_000) {
  const root = mkdtempSync(join(tmpdir(), 'orbit-launcher-wss-'));
  const clipboard = new MemoryClipboard();
  let launches = 0; let revision = 'one';
  let beforeLaunch: (() => Promise<void>) | undefined;
  const service = await startDesktop({ directory: join(root, 'service'), host: '127.0.0.1', port: 0, displayName: 'Orbit Launcher Test',
    discovery: false, sessionTtlMs, clipboard: { createAdapter: () => clipboard, pollMs: 10 }, launcher: { createAdapter: () => ({
      list: async () => [{ key: 'private app registration', name: 'Synthetic App', revision }],
      launch: async (_app, authorize) => { await beforeLaunch?.(); authorize(); launches++; },
    }) } });
  const paired = await pairDesktop(service.pairing.open(), service.hint);
  const client = new OrbitClient(paired); const launcher = new LauncherClient(client);
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    client.stop(); launcher.stop();
    for (const done of cleanup) await done();
    await service.stop(); rmSync(root, { recursive: true, force: true });
  });
  await client.start();
  return { root, client, launcher, service, paired, clipboard, cleanup, launches: () => launches,
    change: () => { revision = 'two'; }, delayLaunch: (fn: () => Promise<void>) => { beforeLaunch = fn; } };
}

test('paired launcher coexists with Clipboard Sync and an active File Transfer', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const local = new MemoryClipboard(); const clipboard = new ClipboardClient(f.client, local, 10);
  const files = new FileClient(f.client, privateDirectory(join(f.root, 'client-files')), f.paired.desktopServiceId);
  f.cleanup.push(() => clipboard.stop(), () => files.stop());
  let active = false; clipboard.on('status', status => { if (status === 'active') active = true; });
  await waitFor(() => active);
  const apps = await f.launcher.list();
  const source = join(f.root, 'synthetic.bin'); writeFileSync(source, Buffer.alloc(32_768 * 32, 42));
  const id = await files.upload(source);
  local.value = { kind: 'text', text: 'synthetic clipboard during launch' };
  await f.launcher.launch(apps[0]!.appId);
  assert.equal(f.launches(), 1);
  await waitFor(() => files.store.records.get(id)?.state === 'completed');
  await waitFor(() => f.clipboard.writes.length > 0);
  f.change();
  await assert.rejects(f.launcher.launch(apps[0]!.appId), /LAUNCHER_STALE_CATALOG/);
  assert.equal(f.launches(), 1);
});

test('renewal interrupts activation preparation without replay; a fresh list restores usability', { timeout: 30_000 }, async t => {
  const f = await fixture(t, 1_500);
  const apps = await f.launcher.list();
  let interrupted = false;
  f.delayLaunch(async () => { await delay(1_400); interrupted = true; });
  await assert.rejects(f.launcher.launch(apps[0]!.appId), /unknown|changed|UNAUTHENTICATED/);
  await waitFor(() => interrupted && f.client.connected);
  assert.equal(f.launches(), 0);
  await assert.rejects(f.launcher.launch(apps[0]!.appId), /LAUNCHER_NOT_FOUND/);
  f.delayLaunch(async () => {});
  const fresh = await f.launcher.list(); await f.launcher.launch(fresh[0]!.appId);
  assert.equal(f.launches(), 1);
});
