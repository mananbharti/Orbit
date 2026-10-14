/** Picks the address phones can reach on the local network; depends on node:os; does not open sockets or touch the network. */
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { isLocalAddress } from './config.js';

// Adapters made by VPNs, VMs and containers are never the Wi-Fi/Ethernet a phone shares.
const VIRTUAL = /(vethernet|virtualbox|vmware|vmnet|docker|veth|br-|hyper-v|wsl|tailscale|zerotier|utun|tun\d|tap\d|loopback|bluetooth)/i;
const WIRELESS_OR_WIRED = /^(wi-?fi|wlan|wlp|wlx|en\d|eth|enp|eno|ethernet)/i;

export function pickLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | undefined {
  let best: { address: string; score: number } | undefined;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isLocalAddress(entry.address)) continue;
      if (entry.address.startsWith('169.254.')) continue; // link-local: DHCP failed
      let score = 1;
      if (VIRTUAL.test(name)) score -= 2;
      if (WIRELESS_OR_WIRED.test(name)) score += 2;
      if (entry.address.startsWith('192.168.')) score += 1; // the usual home/hostel router range
      if (!best || score > best.score) best = { address: entry.address, score };
    }
  }
  return best && best.score > -1 ? best.address : undefined;
}
