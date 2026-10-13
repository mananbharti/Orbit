/** Bridges the core's PinnedTransport to the native OrbitPinnedTransport module (see docs/mobile-transport.md). */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AuthenticationRejected, TransportError, type TransportFailure, type Channel, type ChannelHandlers, type PinnedTransport, type PinnedTrust } from '@orbit/core';

interface NativeModule {
  /** Resolves { status, body } after verifying the pin. Rejects with code PIN_MISMATCH or NETWORK. */
  post(url: string, pinSha256: string, bearer: string, timeoutMs?: number): Promise<{ status: number; body: string }>;
  /** Bonjour/NSD browse for the Orbit service; resolves IPv4 hosts. May be empty. */
  discover(timeoutMs: number): Promise<{ host: string; port: number }[]>;
  localAddress(): string | null;
  open(id: string, url: string, pinSha256: string, bearer: string): void;
  send(id: string, text: string): void;
  close(id: string): void;
  addListener(event: 'orbitChannel', listener: (e: { id: string; kind: 'open' | 'message' | 'close'; text?: string }) => void): { remove(): void };
}

export class MissingNativeTransport extends Error {
  constructor() { super('This build does not include the Orbit secure connection module'); }
}

export function createNativeTransport(uuid: () => string): PinnedTransport {
  const native = requireOptionalNativeModule<NativeModule>('OrbitPinnedTransport');
  const missing = (): never => { throw new MissingNativeTransport(); };
  const handlers = new Map<string, ChannelHandlers>();
  let subscription: { remove(): void } | undefined;
  const ensureListener = (): void => {
    if (subscription || !native) return;
    subscription = native.addListener('orbitChannel', e => {
      const h = handlers.get(e.id);
      if (!h) return;
      if (e.kind === 'open') h.onOpen();
      else if (e.kind === 'message' && typeof e.text === 'string') h.onMessage(e.text);
      else if (e.kind === 'close') { handlers.delete(e.id); h.onClose(); }
    });
  };
  return {
    async postCredential(trust: PinnedTrust, path, token, _signal, options) {
      if (!native) return missing();
      const url = new URL(trust.endpoint);
      url.protocol = 'https:'; url.pathname = path;
      const res = await native.post(url.toString(), trust.certificateFingerprint, token, options?.timeoutMs).catch((e: unknown) => {
        const code = (e as { code?: string })?.code;
        const known: TransportFailure[] = ['pin-mismatch', 'timeout', 'refused', 'unreachable', 'local-network-denied'];
        const kind = code === 'PIN_MISMATCH' ? 'pin-mismatch' : known.find(k => k === code?.toLowerCase().replace(/_/g, '-'));
        throw new TransportError(kind ?? 'unknown');
      });
      if (res.status === 401) throw new AuthenticationRejected();
      if (res.status !== 200) throw new Error('Desktop request rejected');
      return JSON.parse(res.body) as unknown;
    },
    openChannel(trust: PinnedTrust, sessionToken: string, h: ChannelHandlers): Channel {
      if (!native) return missing();
      ensureListener();
      const id = uuid();
      handlers.set(id, h);
      native.open(id, trust.endpoint, trust.certificateFingerprint, sessionToken);
      return { send: text => native.send(id, text), close: () => native.close(id) };
    },
  };
}

/** Phone-side network discovery used to find the same computer again after its address changes. Absent on builds without the native module. */
export function createNativeDiscovery(): { discover: (timeoutMs: number) => Promise<{ host: string; port: number }[]>; localAddress: () => Promise<string | undefined> } {
  const native = requireOptionalNativeModule<NativeModule>('OrbitPinnedTransport');
  return {
    discover: async timeoutMs => (native && typeof native.discover === 'function' ? await native.discover(timeoutMs) : []),
    localAddress: async () => (native && typeof native.localAddress === 'function' ? native.localAddress() ?? undefined : undefined),
  };
}
