/** Desktop startup failure: a taken port is a clean error, leaves nothing running, and the same directory starts fine afterwards. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDesktop } from '../../../desktop/src/desktop-service.js';

test('startup on a taken port fails cleanly, releases the directory lock, and a retry on a free port works', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-startup-'));
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const taken = (blocker.address() as { port: number }).port;
  t.after(() => { blocker.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { directory: join(root, 'private'), host: '127.0.0.1', displayName: 'Orbit Test', discovery: false } as const;

  await assert.rejects(() => startDesktop({ ...options, port: taken }), (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE');
  const service = await startDesktop({ ...options, port: 0 });
  t.after(() => service.stop());
  assert.ok(service.hint.endpoint.startsWith('wss://'), 'the retry started a working service from the same directory');
});

test('another running Orbit on the same data directory is refused, and after it is killed the stale lock is recovered', { timeout: 40_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-startup-two-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'private');
  const module = new URL('../../../desktop/src/desktop-service.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const { startDesktop } = await import(${JSON.stringify(module)}); await startDesktop({ directory: ${JSON.stringify(directory)}, host: '127.0.0.1', port: 0, displayName: 'Other', discovery: false }); console.log('READY'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', d => { if (String(d).includes('READY')) resolve(); });
    child.on('exit', code => reject(new Error(`other instance exited early: ${code}`)));
    setTimeout(() => reject(new Error('other instance did not start')), 15_000);
  });
  const options = { directory, host: '127.0.0.1', displayName: 'Orbit Test', discovery: false } as const;
  await assert.rejects(() => startDesktop({ ...options, port: 0 }), /already running/i);
  child.removeAllListeners('exit');
  child.kill('SIGKILL'); // a crash or End Task leaves the lock file behind
  await new Promise(r => child.once('exit', r));
  const recovered = await startDesktop({ ...options, port: 0 });
  t.after(() => recovered.stop());
  assert.ok(recovered.hint.endpoint.startsWith('wss://'), 'the stale lock of a dead process is taken over');
});
