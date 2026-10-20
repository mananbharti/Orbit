/** Desktop startup failure: a taken port is a clean error, leaves nothing running, and the same directory starts fine afterwards. */
import assert from 'node:assert/strict';
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
