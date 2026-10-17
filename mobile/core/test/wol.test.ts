import assert from 'node:assert/strict';
import test from 'node:test';
import { magicPacket } from '../src/wol.js';

test('a magic packet is 102 bytes: 6 x FF then the MAC 16 times', () => {
  const packet = magicPacket('a1:b2:c3:d4:e5:f6');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.slice(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const mac = [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6];
  for (let i = 0; i < 16; i++) assert.deepEqual([...packet.slice(6 + i * 6, 12 + i * 6)], mac);
});
test('malformed addresses are rejected before any packet exists', () => {
  for (const bad of ['', 'a1:b2:c3:d4:e5', 'A1:B2:C3:D4:E5:F6', 'g1:b2:c3:d4:e5:f6', 'a1-b2-c3-d4-e5-f6', 'a1:b2:c3:d4:e5:f6:07']) {
    assert.throws(() => magicPacket(bad));
  }
});
