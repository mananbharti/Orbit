import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocator } from '../src/locator.js';
import { AuthenticationRejected, TransportError } from '../src/transport.js';
import { FakeTransport, paired } from './fakes.js';

/** Answers only at one endpoint; records every probe and how many ran at once. */
class Probe extends FakeTransport {
  attempts: string[] = [];
  live = 0; peak = 0;
  constructor(private at: string, private reject?: string) { super(); }
  override async postCredential(trust: Parameters<FakeTransport['postCredential']>[0], path: '/v1/pair' | '/v1/session', tok: string): Promise<unknown> {
    this.attempts.push(trust.endpoint);
    this.live++; this.peak = Math.max(this.peak, this.live);
    await new Promise(r => setImmediate(r));
    this.live--;
    if (trust.endpoint === this.reject) throw new AuthenticationRejected();
    if (trust.endpoint !== this.at) throw new TransportError('timeout');
    return super.postCredential(trust, path, tok);
  }
}

test('a discovery that throws still falls through to the subnet scan', async () => {
  const at = 'wss://192.168.1.77:8765/v1/channel';
  const t = new Probe(at);
  const found = await createLocator({ transport: t, discover: async () => { throw new Error('multicast blocked'); }, localAddress: async () => '192.168.1.40' }).find(paired);
  assert.equal(found?.endpoint, at);
});

test('the scan probes both the paired port and the default port on every other address, at most the configured number at once', async () => {
  const t = new Probe('wss://10.9.9.9:1/v1/channel');
  await createLocator({ transport: t, scanConcurrency: 5, fallbackPort: 8765, localAddress: async () => '192.168.1.40' }).find(paired);
  const hosts = new Set(t.attempts.map(a => new URL(a).hostname));
  assert.equal(hosts.size, 253, 'every address in the /24 except the phone itself');
  assert.ok(!hosts.has('192.168.1.40'));
  const ports = new Set(t.attempts.map(a => new URL(a).port));
  assert.ok(ports.has('8765'));
  assert.ok(t.peak <= 5, `peak ${t.peak}`);
});

test('a discovered address equal to the stored one is not probed twice', async () => {
  const stored = new URL(paired.endpoint);
  const t = new Probe('wss://10.9.9.9:1/v1/channel');
  await createLocator({ transport: t, discover: async () => [{ host: stored.hostname, port: Number(stored.port) }, { host: stored.hostname, port: Number(stored.port) }] }).find(paired);
  assert.equal(t.attempts.filter(a => a === paired.endpoint).length, 0);
});

test('a credential rejection during the scan stops it at once instead of probing the rest', async () => {
  const t = new Probe('wss://10.9.9.9:1/v1/channel', 'wss://192.168.1.3:8765/v1/channel');
  await assert.rejects(createLocator({ transport: t, scanConcurrency: 1, fallbackPort: 8765, localAddress: async () => '192.168.1.40' }).find(paired), AuthenticationRejected);
  assert.ok(t.attempts.length < 20, `probed ${t.attempts.length}`);
});
