/** Verifies enrollment, identity persistence and private artifacts; depends on the local Phase 2 service; never enrolls real devices. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { startDesktop } from '../src/desktop-service.js';
import { PairingService, PAIRING_TTL_MS } from '../src/security-pairing/pairing-service.js';
import { FilePairedCredentialStore } from '../src/security-pairing/paired-credential-store.js';
import { pairingPayloadSchema } from '../src/protocol/pairing.js';
import { showPairing } from '../src/security-pairing/pairing-display.js';
import { certificateFingerprint } from '../src/security-pairing/desktop-identity.js';
import { pairDesktop } from '../src/integration-client/pair-desktop.js';
import { postCredential } from '../src/integration-client/pinned-https.js';
import { savePairedDesktop, loadPairedDesktop } from '../src/integration-client/paired-desktop.js';
import { decodeAdvertisement, encodeAdvertisement } from '../src/transport/discovery/lan-discovery.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-pairing-'));
  const options = { directory: join(directory, 'private'), host: '127.0.0.1', port: 0, displayName: 'Orbit Test', discovery: false };
  const service = await startDesktop(options);
  t.after(async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { service, options };
}

test('pairing is closed by default, one-time, and creates durable hashes without logging secrets', async t => {
  const { service } = await fixture(t);
  const trust = { ...service.hint, certificateFingerprint: certificateFingerprint(service.hint.certificate) };
  await assert.rejects(postCredential(trust, '/v1/pair', randomBytes(32).toString('base64url')));
  const qr = service.pairing.open();
  assert.equal(pairingPayloadSchema.safeParse(qr).success, true);
  const paired = await pairDesktop(qr, service.hint);
  await assert.rejects(pairDesktop(qr, service.hint));
  const store = readFileSync(join(service.directory, 'credentials.json'), 'utf8');
  assert.ok(!store.includes(paired.credential));
  assert.ok(service.auth.issue(paired.credential));
  for (const secret of [paired.credential, qr.pairingToken]) assert.ok(!JSON.stringify(service.log.snapshot()).includes(secret));
});

test('concurrent redemptions enroll exactly one device', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  const attempts = await Promise.allSettled([pairDesktop(qr, service.hint), pairDesktop(qr, service.hint)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(JSON.parse(readFileSync(join(service.directory, 'credentials.json'), 'utf8')).length, 1);
});

test('expired, replaced and explicitly closed pairing invitations cannot redeem', async t => {
  const { service } = await fixture(t);
  let now = Date.now();
  const store = new FilePairedCredentialStore(join(service.directory, 'other-credentials.json'));
  const pairing = new PairingService({ ...service.hint,
    certificateFingerprint: certificateFingerprint(service.hint.certificate) }, store, service.log, () => now);
  const first = pairing.open();
  const second = pairing.open();
  assert.equal(pairing.redeem(first.pairingToken), undefined);
  now += PAIRING_TTL_MS;
  assert.equal(pairing.redeem(second.pairingToken), undefined);
  const third = pairing.open();
  pairing.close();
  assert.equal(pairing.redeem(third.pairingToken), undefined);
});

test('a failed durable write consumes the invitation and does not activate a credential', async t => {
  const { service } = await fixture(t);
  const store = new FilePairedCredentialStore(join(service.directory, 'missing', 'credentials.json'));
  const pairing = new PairingService({ ...service.hint,
    certificateFingerprint: certificateFingerprint(service.hint.certificate) }, store, service.log);
  const qr = pairing.open();
  assert.throws(() => pairing.redeem(qr.pairingToken));
  assert.equal(pairing.redeem(qr.pairingToken), undefined);
});

test('identity and paired credentials survive restart; sessions and invitations do not', async t => {
  const { service, options } = await fixture(t);
  const qr = service.pairing.open();
  const paired = await pairDesktop(qr, service.hint);
  savePairedDesktop(service.directory, paired);
  assert.deepEqual(loadPairedDesktop(service.directory), paired);
  const session = service.auth.issue(paired.credential)!;
  await service.stop();
  const restarted = await startDesktop(options);
  t.after(() => restarted.stop());
  assert.equal(restarted.hint.desktopServiceId, service.hint.desktopServiceId);
  assert.equal(restarted.hint.certificate, service.hint.certificate);
  assert.equal(restarted.auth.authenticate(session.sessionToken), undefined);
  assert.ok(restarted.auth.issue(paired.credential));
  assert.equal(restarted.pairing.redeem(qr.pairingToken), undefined);
  await restarted.stop();
});

test('wrong QR pins and substituted discovery identities fail before enrollment', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  await assert.rejects(pairDesktop({ ...qr, certificateFingerprint: '0'.repeat(64) }, service.hint));
  await assert.rejects(pairDesktop(qr, { ...service.hint, endpoint: 'wss://127.0.0.1:1/v1/channel' }));
  assert.equal(existsSync(join(service.directory, 'credentials.json')), false);
  assert.ok(await pairDesktop(qr, service.hint));
});

test('QR artifacts contain the approved payload and can be removed without persistent log contents', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  const cleanup = await showPairing(service.directory, qr);
  assert.deepEqual(JSON.parse(readFileSync(join(service.directory, 'pairing.json'), 'utf8')), qr);
  assert.match(readFileSync(join(service.directory, 'pairing.svg'), 'utf8'), /<svg/);
  cleanup();
  assert.equal(existsSync(join(service.directory, 'pairing.svg')), false);
  assert.equal(existsSync(join(service.directory, 'pairing.json')), false);
});

test('discovery TXT is bounded public metadata and rejects malformed certificate records', async t => {
  const { service } = await fixture(t);
  const qr = service.pairing.open();
  const txt = encodeAdvertisement(service.hint);
  assert.deepEqual(decodeAdvertisement(txt), service.hint);
  assert.ok(!JSON.stringify(txt).includes(qr.pairingToken));
  assert.ok(!JSON.stringify(txt).includes('PRIVATE KEY'));
  assert.equal(decodeAdvertisement({ ...txt, parts: '99' }), undefined);
  assert.equal(decodeAdvertisement({ ...txt, cert0: 'invalid' }), undefined);
  assert.equal(decodeAdvertisement({ ...txt, endpoint: 'ws://127.0.0.1/v1/channel' }), undefined);
  assert.equal(decodeAdvertisement({ ...txt, token: 'unexpected' }), undefined);
});

test('revoking one device ends its access immediately, keeps the other, and survives a restart', async t => {
  const { service } = await fixture(t);
  const one = await pairDesktop(service.pairing.open(), service.hint);
  const two = await pairDesktop(service.pairing.open(['clipboard']), service.hint);
  const sessionOne = service.auth.issue(one.credential)!;
  assert.ok(service.auth.authenticate(sessionOne.sessionToken));
  assert.equal(service.credentials.list().length, 2);
  assert.equal(service.credentials.revoke(one.deviceId), true);
  assert.equal(service.auth.authenticate(sessionOne.sessionToken), undefined, 'live session of the revoked device stops working');
  assert.equal(service.auth.issue(one.credential), undefined, 'its credential cannot start a new session');
  assert.ok(service.auth.issue(two.credential), 'the other device is unaffected');
  assert.equal(service.credentials.revoke(one.deviceId), false, 'unknown or already revoked id');
  const reloaded = new FilePairedCredentialStore(join(service.directory, 'credentials.json'));
  assert.deepEqual(reloaded.list().map(d => d.deviceId), [two.deviceId]);
  assert.deepEqual(reloaded.scopesOf(two.deviceId), ['clipboard']);
});
