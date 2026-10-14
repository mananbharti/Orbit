import test from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { pickLanAddress } from '../src/lan-address.js';

const v4 = (address: string, mac = 'aa:bb:cc:00:11:22', internal = false) => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac, cidr: null }) as NetworkInterfaceInfo;

test('prefers the Wi-Fi adapter over virtual ones', () => {
  assert.equal(pickLanAddress({ 'vEthernet (WSL)': [v4('172.20.0.1')], 'Wi-Fi': [v4('192.168.1.23')], Loopback: [v4('127.0.0.1', '', true)] }), '192.168.1.23');
});
test('ignores link-local, public and loopback addresses', () => {
  assert.equal(pickLanAddress({ Ethernet: [v4('169.254.3.4')], lo: [v4('127.0.0.1', '', true)], wan: [v4('8.8.8.8')] }), undefined);
});
test('returns undefined with no interfaces', () => { assert.equal(pickLanAddress({}), undefined); });
test('VirtualBox host-only adapter named "Ethernet 3" loses to hostel Wi-Fi on 172.31.x (the real failure)', () => {
  assert.equal(pickLanAddress({ 'Ethernet 3': [v4('192.168.56.1', '0a:00:27:00:00:0b')], 'Wi-Fi': [v4('172.31.113.5')] }), '172.31.113.5');
});
test('hypervisor MAC alone disqualifies an adapter with an ordinary-looking name', () => {
  assert.equal(pickLanAddress({ 'Ethernet 2': [v4('192.168.10.2', '00:50:56:c0:00:01')], Ethernet: [v4('192.168.0.9')] }), '192.168.0.9');
});
test('only a virtual adapter present means no address, not a wrong one', () => {
  assert.equal(pickLanAddress({ 'Ethernet 3': [v4('192.168.56.1', '0a:00:27:00:00:0b')] }), undefined);
});
test('the default-route address wins between two real adapters', () => {
  assert.equal(pickLanAddress({ Ethernet: [v4('10.0.0.4')], 'Wi-Fi': [v4('172.31.1.2')] }, '10.0.0.4'), '10.0.0.4');
});
