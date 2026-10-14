import test from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { pickLanAddress } from '../src/lan-address.js';

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as NetworkInterfaceInfo;

test('prefers the Wi-Fi adapter over virtual ones', () => {
  assert.equal(pickLanAddress({ 'vEthernet (WSL)': [v4('172.20.0.1')], 'Wi-Fi': [v4('192.168.1.23')], Loopback: [v4('127.0.0.1', true)] }), '192.168.1.23');
});
test('ignores link-local, public and loopback addresses', () => {
  assert.equal(pickLanAddress({ Ethernet: [v4('169.254.3.4')], lo: [v4('127.0.0.1', true)], wan: [v4('8.8.8.8')] }), undefined);
});
test('returns undefined with no interfaces', () => { assert.equal(pickLanAddress({}), undefined); });
