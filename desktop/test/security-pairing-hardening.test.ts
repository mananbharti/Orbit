import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateIdentity, validateIdentity } from '../src/security-pairing/desktop-identity.js';
import { privateDirectory } from '../src/security-pairing/private-directory.js';
import { lockService } from '../src/security-pairing/service-lock.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'orbit-hard-'));

test('a generated identity validates, persists, and survives a reload', async () => {
  const dir = fresh();
  const identity = await loadOrCreateIdentity(dir);
  validateIdentity(identity);
  const reloaded = await loadOrCreateIdentity(dir);
  assert.deepEqual(reloaded, identity);
  const stored = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
  assert.equal(stored.desktopServiceId, identity.desktopServiceId);
});

test('a substituted private key fails validation', async () => {
  const dir = fresh();
  const identity = await loadOrCreateIdentity(dir);
  const other = await loadOrCreateIdentity(fresh());
  assert.throws(() => validateIdentity({ ...identity, privateKey: other.privateKey }), /invalid or expired/);
});

test('a certificate from another identity fails validation even with matching key fields', async () => {
  const dir = fresh();
  const identity = await loadOrCreateIdentity(dir);
  const other = await loadOrCreateIdentity(fresh());
  assert.throws(() => validateIdentity({ ...identity, certificate: other.certificate }), /invalid or expired/);
});

test('a foreign service id breaks the certificate hostname check', async () => {
  const dir = fresh();
  const identity = await loadOrCreateIdentity(dir);
  const other = await loadOrCreateIdentity(fresh());
  assert.throws(() => validateIdentity({ ...identity, desktopServiceId: other.desktopServiceId }), /invalid or expired/);
});

test('privateDirectory accepts an owner-only directory and rejects a group/world-readable one', () => {
  if (process.platform === 'win32') return;
  const root = fresh();
  const good = privateDirectory(join(root, 'vault'));
  assert.ok(good.endsWith('vault'));
  const open = join(root, 'open');
  mkdirSync(open, { mode: 0o755 });
  assert.throws(() => privateDirectory(open), /not private/);
});

test('lockService refuses a second live lock and recovers a stale one', () => {
  const dir = fresh();
  const release = lockService(dir);
  writeFileSync(join(dir, 'service.lock'), String(process.ppid));
  assert.throws(() => lockService(dir), /already running/);
  release();
  const again = lockService(dir);
  again();
});
