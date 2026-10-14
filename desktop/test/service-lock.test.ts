import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { lockService } from '../src/security-pairing/service-lock.js';

const dir = () => mkdtempSync(join(tmpdir(), 'orbit-lock-'));

test('creates and releases the lock', () => {
  const d = dir(); const unlock = lockService(d);
  assert.equal(readFileSync(join(d, 'service.lock'), 'utf8'), String(process.pid));
  unlock(); assert.equal(existsSync(join(d, 'service.lock')), false);
});
test('recovers from a stale lock left by a dead process', () => {
  const d = dir(); writeFileSync(join(d, 'service.lock'), '2147483646'); // no such pid
  const unlock = lockService(d); unlock();
});
test('recovers from an empty or garbage lock file', () => {
  const d = dir(); writeFileSync(join(d, 'service.lock'), 'junk'); lockService(d)();
});
test('refuses while a live process owns the lock', async () => {
  const d = dir(); const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try { writeFileSync(join(d, 'service.lock'), String(child.pid)); assert.throws(() => lockService(d), /already running/); }
  finally { child.kill(); }
});
test('unlock tolerates a lock that is already gone', () => {
  const d = dir(); const unlock = lockService(d); unlock(); assert.doesNotThrow(unlock);
});
