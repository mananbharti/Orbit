/** Builds Wake-on-LAN magic packets; depends on nothing; performs no network I/O itself (the app layer owns the UDP socket). */
const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** 6 x 0xFF then the 6-byte MAC repeated 16 times: the 102-byte frame every WoL NIC listens for. */
export function magicPacket(mac: string): Uint8Array {
  if (!MAC_PATTERN.test(mac)) throw new Error('Invalid MAC address');
  const bytes = mac.split(':').map(part => Number.parseInt(part, 16));
  const packet = new Uint8Array(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) packet.set(bytes, 6 + i * 6);
  return packet;
}
