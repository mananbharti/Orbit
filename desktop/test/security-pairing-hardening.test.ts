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

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { generate } from 'selfsigned';
import { PairingService } from '../src/security-pairing/pairing-service.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { windowsApproval } from '../src/security-pairing/windows-approval.js';

test('redeem rejects malformed tokens cleanly instead of throwing', () => {
  const dir = fresh();
  const store = new FilePairedCredentialStore(join(dir, 'credentials.json'));
  const log = { record() {} };
  const pairing = new PairingService({ desktopServiceId: randomUUID(), displayName: 'PC',
    endpoint: 'https://192.168.1.2:4700', certificateFingerprint: 'ab'.repeat(32), macAddresses: [] } as never,
    store, log as never);
  const qr = pairing.open();
  assert.equal(pairing.redeem('short'), undefined);
  assert.equal(pairing.redeem('x'.repeat(42)), undefined);
  assert.equal(pairing.redeem('x'.repeat(44)), undefined);
  assert.equal(pairing.redeem('x'.repeat(43) + '!'), undefined);
  assert.equal(pairing.redeem(undefined as never), undefined);
  assert.equal(pairing.redeem({} as never), undefined);
  // the invitation is still open after malformed attempts: format junk does not consume it
  assert.ok(pairing.redeem(qr.pairingToken));
  assert.equal(pairing.redeem(qr.pairingToken), undefined); // one-use
});

test('an approval prompt flooded with endless output is denied without waiting for the timeout', async () => {
  const raw = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), kill() { return true; } });
  const child = raw as unknown as ChildProcessWithoutNullStreams;
  const started = Date.now();
  const promise = windowsApproval(() => child, 60_000).verify(
    { version: 1, type: 'input.begin', requestId: 'r', payload: {} } as never, { session: { deviceId: 'abcdef12-0000' } } as never);
  raw.stdout.write('A'.repeat(100)); // flood: 100 chars, no newline, child never exits
  assert.equal(await promise, false);
  assert.ok(Date.now() - started < 10_000, 'denial must not wait for the full prompt timeout');
});

test('expired and not-yet-valid identity certificates are rejected', async () => {
  const mk = async (notBeforeDate: Date, notAfterDate: Date) => {
    const desktopServiceId = randomUUID();
    const hostname = `orbit-${desktopServiceId}.local`;
    const generated = await generate([{ name: 'commonName', value: hostname }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate, notAfterDate,
      extensions: [ { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] } ],
    });
    return { desktopServiceId, certificate: generated.cert, privateKey: generated.private };
  };
  const expired = await mk(new Date(Date.now() - 200_000), new Date(Date.now() - 100_000));
  assert.throws(() => validateIdentity(expired), /invalid or expired/);
  const future = await mk(new Date(Date.now() + 100_000), new Date(Date.now() + 200_000));
  assert.throws(() => validateIdentity(future), /invalid or expired/);
  const valid = await mk(new Date(Date.now() - 100_000), new Date(Date.now() + 100_000));
  validateIdentity(valid); // control: in-window certificate passes
});
