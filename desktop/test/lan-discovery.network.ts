/** Exercises actual multicast discovery and cold pairing; depends on LAN multicast access; does not replace real-phone validation. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../src/desktop-service.js';
import { discoverDesktop } from '../src/transport/discovery/lan-discovery.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { OrbitClient } from '../src/integration-client/orbit-client.js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryClipboard, waitForClipboard } from './clipboard-helpers.js';
import { ClipboardClient } from '../src/integration-client/clipboard-client.js';
import { FileClient } from '../src/integration-client/file-client.js';
import { privateDirectory } from '../src/security-pairing/private-directory.js';
import { LauncherClient } from '../src/integration-client/launcher-client.js';

test('mDNS public certificate discovery bootstraps pinned pairing and authenticated WSS', { timeout: 25_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-mdns-'));
  const desktopClipboard = new MemoryClipboard();
  const localClipboard = new MemoryClipboard();
  let launches = 0;
  const service = await startDesktop({ directory: join(root, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit LAN Test',
    clipboard: { createAdapter: () => desktopClipboard, pollMs: 10 }, launcher: { createAdapter: () => ({
      list: async () => [{ key: 'synthetic-lan-app', name: 'Synthetic App', revision: 'one' }],
      launch: async (_app, authorize) => { authorize(); launches++; },
    }) } });
  let client: OrbitClient | undefined;
  let clipboard: ClipboardClient | undefined;
  let files: FileClient | undefined;
  try {
    const qr = service.pairing.open();
    const hint = await discoverDesktop(qr);
    assert.equal(hint.certificate, service.hint.certificate);
    const paired = await pairDesktop(qr, hint);
    client = new OrbitClient(paired);
    await client.start();
    assert.deepEqual((await client.command('test.unregistered', null)).payload,
      { ok: false, error: { code: 'UNKNOWN_COMMAND' } });
    clipboard = new ClipboardClient(client, localClipboard, 10);
    let active = false;
    clipboard.on('status', status => { if (status === 'active') active = true; });
    await waitForClipboard(() => active);
    localClipboard.value = { kind: 'text', text: 'synthetic clipboard over discovered WSS' };
    await waitForClipboard(() => desktopClipboard.writes.length === 1);
    desktopClipboard.value = { kind: 'text', text: 'synthetic desktop response over discovered WSS' };
    await waitForClipboard(() => localClipboard.writes.length === 1);
    assert.deepEqual(localClipboard.value, desktopClipboard.value);
    files = new FileClient(client, privateDirectory(join(root, 'file-client')), paired.desktopServiceId);
    const source = join(root, 'synthetic-lan.bin'); const bytes = Buffer.alloc(70_001, 83); writeFileSync(source, bytes);
    const upload = await files.upload(source);
    await waitForClipboard(() => files!.store.records.get(upload)?.state === 'completed');
    const offer = await service.files.offerLocal(source, paired.deviceId);
    await files.download(offer.transferId);
    await waitForClipboard(() => files!.store.records.get(offer.transferId)?.state === 'completed');
    assert.deepEqual(readFileSync(files.store.paths(files.store.records.get(offer.transferId)!).destination), bytes);
    const launcher = new LauncherClient(client);
    try { const apps = await launcher.list(); await launcher.launch(apps[0]!.appId); assert.equal(launches, 1); }
    finally { launcher.stop(); }
  } finally {
    client?.stop();
    await files?.stop();
    await clipboard?.stop();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop and integration-client CLIs complete local pairing without printing secrets', { timeout: 40_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-cli-'));
  const port = await new Promise<number>(resolve => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address() as import('node:net').AddressInfo;
      reservation.close(() => resolve(address.port));
    });
  });
  const serviceDirectory = join(root, 'service');
  const env = { ...process.env, ORBIT_HOST: '127.0.0.1', ORBIT_PORT: String(port),
    ORBIT_DATA_DIR: serviceDirectory, ORBIT_CLIENT_DIR: join(root, 'client'),
    ORBIT_TLS_CERT: '', ORBIT_TLS_KEY: '', ORBIT_CREDENTIAL_STORE: '' };
  const desktop = spawn(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url)), '--pair'],
    { env, windowsHide: true, stdio: 'pipe' });
  t.signal.addEventListener('abort', () => desktop.kill(), { once: true });
  let output = '';
  desktop.stdout.on('data', data => { output += String(data); });
  desktop.stderr.on('data', data => { output += String(data); });
  const exited = new Promise<number | null>(resolve => desktop.once('exit', resolve));
  try {
    const deadline = Date.now() + 15_000;
    while (!output.includes('Pairing is open')) {
      if (Date.now() > deadline || desktop.exitCode !== null) throw new Error('Desktop CLI did not open pairing');
      await delay(50);
    }
    const qrPath = join(serviceDirectory, 'pairing.json');
    const token = (JSON.parse(readFileSync(qrPath, 'utf8')) as { pairingToken: string }).pairingToken;
    const paired = spawn(process.execPath, [fileURLToPath(new URL('../src/integration-client/main.js', import.meta.url)), 'pair', qrPath],
      { env, windowsHide: true, stdio: 'pipe' });
    let clientOutput = '';
    paired.stdout.on('data', data => { clientOutput += String(data); });
    paired.stderr.on('data', data => { clientOutput += String(data); });
    const killTimer = setTimeout(() => paired.kill(), 15_000);
    const code = await new Promise<number | null>(resolve => paired.once('exit', resolve));
    clearTimeout(killTimer);
    assert.equal(code, 0, clientOutput);
    const credential = (JSON.parse(readFileSync(join(root, 'client', 'paired-desktop.json'), 'utf8')) as { credential: string }).credential;
    assert.ok(!output.includes(token) && !clientOutput.includes(token));
    assert.ok(!output.includes(credential) && !clientOutput.includes(credential));
    desktop.stdin.write('quit\n');
    const stopTimer = setTimeout(() => desktop.kill(), 5_000);
    try { assert.equal(await exited, 0, 'Desktop CLI must exit gracefully after quit'); }
    finally { clearTimeout(stopTimer); }
  } finally {
    desktop.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
