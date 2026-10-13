import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocator } from '../src/locator.js';
import { OrbitSession, type SessionStatus } from '../src/session.js';
import { AuthenticationRejected, TransportError } from '../src/transport.js';
import { FakeTransport, paired, sleep } from './fakes.js';

const NEW_IP = 'wss://192.168.1.77:8443/v1/channel';
/** A network where the desktop only answers at one endpoint; everything else times out. */
class MovedDesktop extends FakeTransport {
  constructor(public at: string) { super(); }
  attempts: string[] = [];
  override async postCredential(trust: Parameters<FakeTransport['postCredential']>[0], path: '/v1/pair' | '/v1/session', tok: string, _signal?: AbortSignal, _options?: { timeoutMs?: number }): Promise<unknown> {
    this.attempts.push(trust.endpoint);
    if (trust.endpoint !== this.at) throw new TransportError('timeout');
    return super.postCredential(trust, path, tok);
  }
}
const uuid = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();

test('locator finds the desktop through discovery and verifies it with the pinned credential request', async () => {
  const t = new MovedDesktop(NEW_IP);
  const locator = createLocator({ transport: t, discover: async () => [{ host: '192.168.1.77', port: 8443 }] });
  const found = await locator.find(paired);
  assert.equal(found?.endpoint, NEW_IP);
  assert.ok(found?.raw);
  assert.equal(t.posts.at(-1)!.trust.certificateFingerprint, paired.certificateFingerprint);
});
test('locator ignores discovery hosts that are not private addresses or fail the pin', async () => {
  const t = new MovedDesktop(NEW_IP);
  const locator = createLocator({ transport: t, discover: async () => [{ host: '8.8.8.8', port: 8443 }, { host: '192.168.1.99', port: 8443 }] });
  assert.equal(await locator.find(paired), undefined);
  assert.ok(!t.attempts.includes('wss://8.8.8.8:8443/v1/channel'));
});
test('locator falls back to scanning the phone subnet when discovery finds nothing', async () => {
  const t = new MovedDesktop(NEW_IP);
  const locator = createLocator({ transport: t, discover: async () => [], localAddress: async () => '192.168.1.40' });
  const found = await locator.find(paired);
  assert.equal(found?.endpoint, NEW_IP);
  assert.ok(!t.attempts.includes('wss://192.168.1.40:8443/v1/channel'), 'skips its own address');
  assert.ok(!t.attempts.includes(paired.endpoint), 'does not retry the address that already failed');
});
test('locator gives up cleanly when nothing answers, and when the phone address is unusable', async () => {
  assert.equal(await createLocator({ transport: new MovedDesktop('wss://10.0.0.1:1/v1/channel'), localAddress: async () => '192.168.1.40' }).find(paired), undefined);
  assert.equal(await createLocator({ transport: new MovedDesktop(NEW_IP), localAddress: async () => '999.1.1.1' }).find(paired), undefined);
  assert.equal(await createLocator({ transport: new MovedDesktop(NEW_IP), localAddress: async () => undefined }).find(paired), undefined);
});
test('a desktop that answers but rejects the credential surfaces as authentication rejected', async () => {
  const t = new MovedDesktop(NEW_IP);
  t.failPost = new AuthenticationRejected();
  const locator = createLocator({ transport: t, discover: async () => [{ host: '192.168.1.77', port: 8443 }] });
  await assert.rejects(locator.find(paired), AuthenticationRejected);
});

test('session follows the desktop to its new address without re-pairing and reports the change', async () => {
  const t = new MovedDesktop(NEW_IP);
  const changed: string[] = [];
  const seen: SessionStatus[] = [];
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0,
    locator: createLocator({ transport: t, discover: async () => [{ host: '192.168.1.77', port: 8443 }] }),
    onEndpointChanged: e => changed.push(e) });
  s.onStatus(x => seen.push(x));
  await s.start();
  assert.equal(s.status, 'connected');
  assert.deepEqual(changed, [NEW_IP]);
  assert.ok(seen.includes('searching'));
  assert.equal(t.channels.length, 1);
  s.stop();
});
test('first start with an unreachable desktop keeps retrying instead of giving up', async () => {
  const t = new MovedDesktop('wss://10.9.9.9:8443/v1/channel');
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, retryMaxMs: 20, random: () => 0 });
  await s.start();
  assert.equal(s.status, 'reconnecting');
  t.at = paired.endpoint;
  await sleep(120);
  assert.equal(s.status, 'connected');
  s.stop();
});
test('search is rate limited so a missing desktop is not scanned on every retry', async () => {
  const t = new MovedDesktop('wss://10.9.9.9:8443/v1/channel');
  let searches = 0;
  const s = new OrbitSession(paired, t, { uuid, retryBaseMs: 5, retryMaxMs: 10, random: () => 0, searchCooldownMs: 60_000,
    locator: { find: async () => { searches++; return undefined; } } });
  await s.start();
  await sleep(150);
  assert.equal(searches, 1);
  s.stop();
});
