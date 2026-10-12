/** Tests permission scopes: storage, pairing, enforcement and fail-closed behaviour. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ActivityLog } from '../src/activity-log/activity-log.js';
import { CommandRegistry } from '../src/command-router/command-registry.js';
import { CommandRouter } from '../src/command-router/command-router.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { PairingService } from '../src/security-pairing/pairing-service.js';
import { isCommandAllowed, parseScopes } from '../src/security-pairing/scopes.js';
import { SessionAuth } from '../src/security-pairing/session-auth.js';

const dir = (t: TestContext) => { const d = mkdtempSync(join(tmpdir(), 'orbit-scopes-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const identity = { desktopServiceId: randomUUID(), displayName: 'T', endpoint: 'wss://127.0.0.1:1/v1/channel', certificateFingerprint: 'a'.repeat(64) };

function world(t: TestContext) {
  const path = join(dir(t), 'credentials.json');
  const log = new ActivityLog();
  const store = new FilePairedCredentialStore(path);
  const pairing = new PairingService(identity, store, log);
  const auth = new SessionAuth(store, log);
  const registry = new CommandRegistry();
  for (const type of ['agent.list', 'clipboard.write', 'file.offers', 'launcher.list', 'test.echo']) registry.register(type, { validate: () => true, execute: async () => 'ran' });
  const router = new CommandRouter(registry, auth, log, { verify: async () => true });
  const pair = (scopes?: any) => { const token = pairing.open(scopes).pairingToken; return pairing.redeem(token)!; };
  const run = async (credential: string, type: string) => {
    const issued = auth.issue(credential)!;
    return router.dispatch({ version: 1, type, payload: null, requestId: randomUUID() }, issued.sessionToken);
  };
  return { path, store, pair, run };
}
const denied = (r: any) => r.payload.ok === false && r.payload.error.code === 'SCOPE_DENIED';

test('a device paired with scopes can only use those command families', async t => {
  const w = world(t);
  const { credential } = w.pair(['agent', 'clipboard']);
  assert.equal((await w.run(credential, 'agent.list')).payload.ok, true);
  assert.equal((await w.run(credential, 'clipboard.write')).payload.ok, true);
  assert.ok(denied(await w.run(credential, 'file.offers')));
  assert.ok(denied(await w.run(credential, 'launcher.list')));
});
test('scoped devices cannot reach command families with no scope mapping (fail closed)', async t => {
  const w = world(t);
  assert.ok(denied(await w.run(w.pair(['agent']).credential, 'test.echo')));
});
test('devices paired without scopes keep full access, including unmapped families', async t => {
  const w = world(t);
  const { credential } = w.pair();
  for (const type of ['agent.list', 'file.offers', 'launcher.list', 'test.echo']) assert.equal((await w.run(credential, type)).payload.ok, true, type);
});
test('scopes persist across restarts and legacy store files still load', async t => {
  const w = world(t);
  const scoped = w.pair(['files']); const full = w.pair();
  const reloaded = new FilePairedCredentialStore(w.path);
  assert.deepEqual(reloaded.scopesOf(scoped.deviceId), ['files']);
  assert.equal(reloaded.scopesOf(full.deviceId), undefined);
  const stored = JSON.parse(readFileSync(w.path, 'utf8'));
  const legacy = stored.map(({ deviceId, credentialHash }: any) => ({ deviceId, credentialHash }));
  writeFileSync(w.path, JSON.stringify(legacy));
  const old = new FilePairedCredentialStore(w.path);
  assert.equal(old.scopesOf(scoped.deviceId), undefined, 'legacy entries mean full access');
});
test('a corrupt or unknown scope in the store is rejected, never widened', t => {
  const path = join(dir(t), 'c.json');
  for (const scopes of [[], ['root'], 'agent', [1]]) {
    writeFileSync(path, JSON.stringify([{ deviceId: randomUUID(), credentialHash: 'a'.repeat(64), scopes }]));
    assert.throws(() => new FilePairedCredentialStore(path), /Invalid paired credential store/);
  }
});
test('scopes belong to the one invitation that set them', async t => {
  const w = world(t);
  const first = w.pair(['agent']);
  const second = w.pair();
  assert.ok(denied(await w.run(first.credential, 'file.offers')));
  assert.equal((await w.run(second.credential, 'file.offers')).payload.ok, true);
});
test('scope parsing accepts all or a valid list and rejects anything else', () => {
  assert.equal(parseScopes(undefined), undefined);
  assert.equal(parseScopes('all'), undefined);
  assert.equal(parseScopes(''), undefined);
  assert.deepEqual(parseScopes('agent, files,agent'), ['agent', 'files']);
  for (const bad of ['agent,root', 'Agent', ',', 'agent;files']) assert.throws(() => parseScopes(bad), /ORBIT_PAIR_SCOPES/);
  assert.equal(isCommandAllowed(['input'], 'input.move'), true);
  assert.equal(isCommandAllowed(['input'], 'agent.list'), false);
});
