/** Manages the devices paired to the computer; depends on OrbitSession and Zod; only full-access devices may call these. */
import { InvalidDesktopReply } from './agent.js';
import { SCOPES, pairDevicesResultSchema, type DeviceInfo, type Scope } from './protocol.js';
import { CommandError, NotSent, type OrbitSession } from './session.js';

const DEVICES_TIMEOUT_MS = 10_000;

export class DevicesApi {
  private current = '';
  private devices: DeviceInfo[] = [];
  constructor(private readonly session: OrbitSession) {
    session.onStatus(() => { this.current = ''; this.devices = []; });
  }

  /** Paired devices as of the last refresh, with this device's id first-class via currentId(). */
  getDevices(): DeviceInfo[] { return [...this.devices]; }
  currentId(): string { return this.current; }

  async refresh(): Promise<DeviceInfo[]> {
    const result: unknown = await this.session.command('pair.devices', {}, { timeoutMs: DEVICES_TIMEOUT_MS });
    const parsed = pairDevicesResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.current = parsed.data.current;
    this.devices = parsed.data.devices;
    return this.getDevices();
  }

  /** Sets one device's permissions; 'all' restores full access. Returns the fresh list. */
  async setScopes(deviceId: string, scopes: readonly Scope[] | 'all'): Promise<DeviceInfo[]> {
    const result: unknown = await this.session.command('pair.scopes.set',
      { deviceId, scopes: scopes === 'all' ? 'all' : [...scopes] }, { timeoutMs: DEVICES_TIMEOUT_MS });
    const parsed = pairDevicesResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.current = parsed.data.current;
    this.devices = parsed.data.devices;
    return this.getDevices();
  }

  /** Removes a device's pairing from the computer entirely. Returns the fresh list (already excluding it). */
  async revoke(deviceId: string): Promise<DeviceInfo[]> {
    const result: unknown = await this.session.command('pair.revoke', { deviceId }, { timeoutMs: DEVICES_TIMEOUT_MS });
    const parsed = pairDevicesResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidDesktopReply();
    this.current = parsed.data.current;
    this.devices = parsed.data.devices;
    return this.getDevices();
  }
}

/** Every permission, in a stable order for display. */
export function allScopes(): Scope[] { return [...SCOPES]; }
export { CommandError, NotSent };
