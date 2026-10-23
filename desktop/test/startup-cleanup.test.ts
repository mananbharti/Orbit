/** Pins startup-failure cleanup: a failed startDesktop must release the service lock and every started part. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { startDesktop } from '../src/desktop-service.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';

test('a failed startup releases the lock and the port so a retry with the same options succeeds', async t => {
  const root = mkdtempSync(join(tmpdir(), 'orbit-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as { port: number }).port;
  const options = () => ({ directory: join(root, 'private'), host: '127.0.0.1', port,
    displayName: 'Orbit Test', discovery: false, sessionTtlMs: 60_000, registry: new CommandRegistry() });
  await assert.rejects(startDesktop(options()), /EADDRINUSE|listen/);
  // The lock file must be gone and no half-started service may hold anything: a plain retry works.
  await new Promise<void>(resolve => blocker.close(() => resolve()));
  const service = await startDesktop(options());
  assert.ok(service.hint.endpoint.includes('127.0.0.1'));
  await service.stop();
  // And a second clean start/stop cycle leaves nothing behind either.
  const again = await startDesktop(options());
  await again.stop();
});
