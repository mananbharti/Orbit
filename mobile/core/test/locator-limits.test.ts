import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocator } from '../src/locator.js';
import { TransportError } from '../src/transport.js';
import { FakeTransport, paired } from './fakes.js';

/** Never answers; records each probe, its timeout, and how many ran at once. */
class Silent extends FakeTransport {
  attempts: string[] = [];
  timeouts = new Set<unknown>();
  live = 0; peak = 0;
  override async postCredential(trust: Parameters<FakeTransport['postCredential']>[0], _path: '/v1/pair' | '/v1/session', _tok: string, ...rest: unknown[]): Promise<unknown> {
    this.attempts.push(trust.endpoint);
    this.timeouts.add((rest[1] as { timeoutMs?: number } | undefined)?.timeoutMs);
    this.live++; this.peak = Math.max(this.peak, this.live);
    await new Promise(resolve => setTimeout(resolve, 1));
    this.live--;
    throw new TransportError('timeout');
  }
}

test('probe and discovery time limits default to 1.5 s and 4 s and can be overridden', async () => {
  const seen: number[] = [];
  const t = new Silent();
  await createLocator({ transport: t, discover: async ms => { seen.push(ms); return [{ host: '192.168.1.9', port: 8765 }]; } }).find(paired);
  assert.deepEqual(seen, [4_000]);
  assert.deepEqual([...t.timeouts], [1_500]);
  const custom = new Silent();
  await createLocator({ transport: custom, discoverTimeoutMs: 250, probeTimeoutMs: 700, discover: async ms => { seen.push(ms); return [{ host: '192.168.1.9', port: 8765 }]; } }).find(paired);
  assert.equal(seen.at(-1), 250);
  assert.deepEqual([...custom.timeouts], [700]);
});

test('discovered hosts are probed four at a time and the subnet scan defaults to 32 at a time', async () => {
  const hosts = Array.from({ length: 12 }, (_, i) => ({ host: `192.168.1.${100 + i}`, port: 8765 }));
  const discovery = new Silent();
  await createLocator({ transport: discovery, discover: async () => hosts }).find(paired);
  assert.equal(discovery.peak, 4);
  const scan = new Silent();
  await createLocator({ transport: scan, localAddress: async () => '192.168.1.40' }).find(paired);
  assert.equal(scan.peak, 32);
});

test('a phone address with an octet above 255 is unusable, 255 itself is fine, and a repeated port is scanned once', async () => {
  const bad = new Silent();
  assert.equal(await createLocator({ transport: bad, localAddress: async () => '192.168.1.256' }).find(paired), undefined);
  assert.equal(bad.attempts.length, 0);
  const edge = new Silent();
  await createLocator({ transport: edge, localAddress: async () => '192.168.1.255' }).find(paired);
  assert.ok(edge.attempts.length > 0);
  const samePort = new Silent();
  const port = Number(new URL(paired.endpoint).port);
  await createLocator({ transport: samePort, fallbackPort: port, localAddress: async () => '192.168.1.40' }).find(paired);
  // 253 other addresses, minus the stored endpoint that is never probed again.
  assert.equal(samePort.attempts.length, 252);
  assert.equal(new Set(samePort.attempts).size, 252);
});
