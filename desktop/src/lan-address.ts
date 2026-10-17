/** Picks the address phones can reach on the local network; depends on node:os and node:dgram; sends no packets. */
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { createSocket } from 'node:dgram';
import { isLocalAddress } from './config.js';

// Adapters made by VPNs, VMs and containers are never the Wi-Fi/Ethernet a phone shares.
const VIRTUAL_NAME = /(vethernet|virtualbox|vbox|vmware|vmnet|docker|veth|br-|hyper-v|wsl|tailscale|zerotier|utun|tun\d|tap\d|loopback|bluetooth|host-only)/i;
// Hardware address prefixes assigned to hypervisors (VirtualBox, VMware, Hyper-V, Parallels, Xen). Windows names these "Ethernet 2", so the name alone cannot tell.
const VIRTUAL_MAC = /^(0a:00:27|00:50:56|00:0c:29|00:05:69|00:15:5d|00:1c:42|00:16:3e|52:54:00)/i;
// Default subnets of VirtualBox host-only (56), docker-machine (99) and WSL/Hyper-V default switch (172.16-31 is NOT excluded: real networks use it).
const VIRTUAL_SUBNET = /^192\.168\.(56|99)\./;
const WIFI = /^(wi-?fi|wlan|wlp|wlx|wireless)/i;
const WIRED = /^(en\d|eth|enp|eno|ethernet)/i;

export function isVirtualAdapter(name: string, entry: NetworkInterfaceInfo): boolean {
  return VIRTUAL_NAME.test(name) || VIRTUAL_MAC.test(entry.mac ?? '') || VIRTUAL_SUBNET.test(entry.address);
}

/** `preferred` is the address the OS routes internet traffic through (see defaultRouteAddress); it wins unless it is a virtual adapter. */
export function pickLanAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), preferred?: string): string | undefined {
  let best: { address: string; score: number } | undefined;
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !isLocalAddress(entry.address)) continue;
      if (entry.address.startsWith('169.254.')) continue; // link-local: DHCP failed
      if (isVirtualAdapter(name, entry)) continue;
      let score = 1;
      if (WIFI.test(name)) score += 3; else if (WIRED.test(name)) score += 2;
      if (preferred && entry.address === preferred) score += 10;
      if (!best || score > best.score) best = { address: entry.address, score };
    }
  }
  return best?.address;
}

/** The local address the OS would use to reach the internet. Connecting a UDP socket sends nothing; it only makes the OS choose a route. */
export function defaultRouteAddress(): Promise<string | undefined> {
  return new Promise(resolve => {
    const socket = createSocket('udp4');
    const done = (value?: string) => { try { socket.close(); } catch { /* already closed */ } resolve(value); };
    socket.once('error', () => done());
    try { socket.connect(53, '1.1.1.1', () => done(socket.address().address)); } catch { done(); }
  });
}

/** Hardware addresses of the real Wi-Fi/Ethernet interfaces, for Wake-on-LAN at pairing time. Lowercase, deduped, capped at 4. */
export function lanMacAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const macs: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.mac || entry.mac === '00:00:00:00:00:00') continue;
      if (isVirtualAdapter(name, entry)) continue;
      const mac = entry.mac.toLowerCase();
      if (!macs.includes(mac)) macs.push(mac);
    }
  }
  return macs.slice(0, 4);
}
