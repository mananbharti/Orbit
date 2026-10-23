/** Verifies the paired-credential store caps the main suite leaves open: at most 128 enrolled devices and at most 128 persisted entries; depends on temp directories only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';

function dir(t: TestContext): string { const d = mkdtempSync(join(tmpdir(), 'orbit-cred-edges-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; }

test('enrollment stops at 128 devices', t => {
  const store = new FilePairedCredentialStore(join(dir(t), 'paired.json'));
  for (let i = 0; i < 128; i++) store.enroll();
  assert.throws(() => store.enroll(), /Pairing store unavailable/);
});

test('a persisted store with more than 128 entries is refused whole', t => {
  const path = join(dir(t), 'paired.json');
  const entries = Array.from({ length: 129 }, (_, i) => ({ deviceId: crypto.randomUUID(), credentialHash: i.toString(16).padStart(64, '0') }));
  writeFileSync(path, JSON.stringify(entries));
  assert.throws(() => new FilePairedCredentialStore(path), /Invalid paired credential store/);
});
