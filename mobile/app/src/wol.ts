/**
 * Wake-on-LAN for iOS: broadcasts the magic packet over UDP. react-native-udp is a native module, so
 * it loads dynamically - the web preview (no module) keeps working, and the button hides there.
 */
import { magicPacket } from '@orbit/core';
import { Platform } from 'react-native';

type UdpSocket = { bind: (port: number) => void; setBroadcast: (flag: boolean) => void;
  send: (data: Uint8Array, offset: number, length: number, port: number, host: string, callback?: (error?: Error) => void) => void; close: () => void; };
type UdpModule = { createSocket: (options: { type: string }) => UdpSocket; };
let moduleCache: UdpModule | null | undefined;
function udpModule(): UdpModule | null {
  if (Platform.OS === 'web') return null;
  if (moduleCache === undefined) {
    try { moduleCache = (require('react-native-udp') as { default?: UdpModule }).default ?? (require('react-native-udp') as UdpModule); }
    catch { moduleCache = null; }
  }
  return moduleCache;
}
/** Whether a wake can even be attempted on this build (native module present, real NIC addresses known). */
export function canWake(macAddresses: string[] | undefined): boolean { return !!macAddresses?.length && udpModule() !== null; }

/** Broadcasts one magic packet per known NIC on port 9 and again on port 7 (both are standard WoL ports). */
export function wakeDesktop(macAddresses: string[]): Promise<void> {
  const udp = udpModule();
  if (!udp || !macAddresses.length) return Promise.reject(new Error('Wake-on-LAN needs the native app.'));
  return new Promise((resolve, reject) => {
    const socket = udp.createSocket({ type: 'udp4' });
    socket.bind(0);
    socket.setBroadcast(true);
    const packets = macAddresses.map(mac => magicPacket(mac));
    let sent = 0; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      if (error) { settled = true; socket.close(); reject(error); return; }
      sent++;
      if (sent >= packets.length * 2) { settled = true; socket.close(); resolve(); }
    };
    for (const packet of packets) {
      socket.send(packet, 0, packet.length, 9, '255.255.255.255', finish);
      socket.send(packet, 0, packet.length, 7, '255.255.255.255', finish);
    }
  });
}
