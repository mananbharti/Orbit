/** Tests durable-store boundaries and short-lived sessions; depends on temporary files; never writes production credentials. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { readConfig } from '../src/config.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { credentialHash, SessionAuth } from '../src/security-pairing/session-auth.js';
import { core } from './helpers.js';

test('session tokens are distinct from credentials and expire or revoke immediately', () => {
  let now = Date.now();
  const fixture = core({ ttlMs: 100, now: () => now });
  assert.equal(fixture.auth.issue('bad'), undefined);
  const first = fixture.auth.issue(fixture.credential)!;
  const second = fixture.auth.issue(fixture.credential)!;
  assert.notEqual(first.sessionToken, fixture.credential);
  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.equal(fixture.auth.authenticate(fixture.credential), undefined);
  now += 100;
  assert.equal(fixture.auth.authenticate(first.sessionToken), undefined);
  const third = fixture.auth.issue(fixture.credential)!;
  fixture.revoke();
  assert.equal(fixture.auth.authenticate(third.sessionToken), undefined);
  assert.equal(fixture.auth.issue(fixture.credential), undefined);
  assert.ok(fixture.log.snapshot().every(event => !JSON.stringify(event).includes(fixture.credential)));
});

test('session issue caps evict the oldest session of a device and refuse a full store', () => {
  const fixture = core();
  const tokens: string[] = [];
  for (let i = 0; i < 8; i++) tokens.push(fixture.auth.issue(fixture.credential)!.sessionToken);
  for (const token of tokens) assert.ok(fixture.auth.authenticate(token));
  const ninth = fixture.auth.issue(fixture.credential)!.sessionToken;
  assert.equal(fixture.auth.authenticate(tokens[0]!), undefined, 'the ninth session of one device evicts its oldest');
  assert.ok(fixture.auth.authenticate(ninth));
  for (let d = 0; d < 15; d++) {
    const other = fixture.addDevice();
    for (let i = 0; i < 8; i++) fixture.auth.issue(other.credential);
  }
  const extra = fixture.addDevice();
  assert.equal(fixture.auth.issue(extra.credential), undefined, 'a full session store refuses new sessions');
});

test('durable credential hashes survive service reconstruction, session tokens do not', t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-credentials-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'paired.json');
  const credential = randomBytes(32).toString('base64url');
  const deviceId = randomUUID();
  writeFileSync(path, JSON.stringify([{ deviceId, credentialHash: credentialHash(credential) }]));
  const first = new SessionAuth(new FilePairedCredentialStore(path), new ActivityLog());
  const old = first.issue(credential)!;
  const second = new SessionAuth(new FilePairedCredentialStore(path), new ActivityLog());
  assert.equal(second.authenticate(old.sessionToken), undefined);
  assert.equal(second.issue(credential)!.session.deviceId, deviceId);
  assert.equal(new SessionAuth(new FilePairedCredentialStore(), new ActivityLog()).issue(credential), undefined);
  writeFileSync(path, '[{"deviceId":"unvalidated", "credentialHash":"bad"}]');
  assert.throws(() => new FilePairedCredentialStore(path));
});

test('configuration rejects legacy TLS overrides and wildcard/public bind addresses', () => {
  assert.throws(() => readConfig({ ORBIT_TLS_CERT: 'cert' }));
  for (const host of ['0.0.0.0', '::', '8.8.8.8', 'example.com']) {
    assert.throws(() => readConfig({ ORBIT_HOST: host }));
  }
  assert.equal(readConfig({}).host, '127.0.0.1');
});

test('scope changes apply to live sessions on the next command, not only on reconnect', t => {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-scopes-live-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'paired.json');
  const credential = randomBytes(32).toString('base64url');
  const deviceId = randomUUID();
  writeFileSync(path, JSON.stringify([{ deviceId, credentialHash: credentialHash(credential) }]));
  const store = new FilePairedCredentialStore(path);
  const auth = new SessionAuth(store, new ActivityLog());
  const issued = auth.issue(credential)!;
  assert.equal(issued.session.scopes, undefined); // full access at pairing time
  assert.equal(store.setScopes(deviceId, ['memory']), true);
  assert.deepEqual(auth.authenticate(issued.sessionToken)?.scopes, ['memory']); // narrowed without reconnect
  assert.equal(store.setScopes(deviceId, undefined), true);
  assert.equal(auth.authenticate(issued.sessionToken)?.scopes, undefined); // restored without reconnect
  assert.equal(store.setScopes(deviceId, ['memory', 'agent']), true);
  assert.deepEqual(auth.authenticate(issued.sessionToken)?.scopes, ['memory', 'agent']); // sets of scopes, any stored order
});
