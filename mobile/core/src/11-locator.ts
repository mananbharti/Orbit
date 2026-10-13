/** Finds a paired desktop again after its IP changed. Depends on the pinned transport; the pinned certificate is the only identity check, so a device that merely answers on the network can never be trusted or sent the credential. */
import { endpointSchema, type PairedDesktop } from './protocol.js';
import { AuthenticationRejected, type PinnedTransport } from './transport.js';
import type { EndpointLocator } from './session.js';

export interface DiscoveredHost { host: string; port: number }
export interface LocatorDeps {
  transport: PinnedTransport;
  /** Bonjour/NSD browse for the Orbit service. May return nothing when multicast is blocked. */
  discover?: (timeoutMs: number) => Promise<DiscoveredHost[]>;
  /** This phone's own IPv4 address on the Wi-Fi, used to scan the subnet when discovery finds nothing. */
  localAddress?: () => Promise<string | undefined>;
  discoverTimeoutMs?: number;
  probeTimeoutMs?: number;
  scanConcurrency?: number;
  fallbackPort?: number;
}

const buildEndpoint = (host: string, port: number): string | undefined => {
  const candidate = `wss://${host}:${port}/v1/channel`;
  return endpointSchema.safeParse(candidate).success ? candidate : undefined;
};
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function createLocator(deps: LocatorDeps): EndpointLocator {
  const probeTimeoutMs = deps.probeTimeoutMs ?? 1_500;
  return {
    async find(paired: PairedDesktop) {
      const probe = async (endpoint: string): Promise<{ endpoint: string; raw: unknown } | undefined> => {
        try {
          const raw = await deps.transport.postCredential({ desktopServiceId: paired.desktopServiceId, endpoint,
            certificateFingerprint: paired.certificateFingerprint }, '/v1/session', paired.credential, undefined, { timeoutMs: probeTimeoutMs });
          return { endpoint, raw };
        } catch (error) {
          if (error instanceof AuthenticationRejected) throw error;
          return undefined;
        }
      };
      const firstSuccess = async (endpoints: string[], concurrency: number) => {
        let next = 0;
        let found: { endpoint: string; raw: unknown } | undefined;
        let rejected: unknown;
        const worker = async () => {
          while (!found && !rejected) {
            const endpoint = endpoints[next++];
            if (!endpoint) return;
            try { const hit = await probe(endpoint); if (hit && !found) found = hit; } catch (e) { rejected = e; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, endpoints.length) }, worker));
        if (rejected) throw rejected;
        return found;
      };

      const port = Number(new URL(paired.endpoint).port || 443);
      const ports = [...new Set([port, deps.fallbackPort ?? 8765])];
      const tried = new Set<string>([paired.endpoint]);

      let hosts: DiscoveredHost[] = [];
      try { hosts = (await deps.discover?.(deps.discoverTimeoutMs ?? 4_000)) ?? []; } catch { hosts = []; }
      const discovered = hosts.map(h => buildEndpoint(h.host, h.port)).filter((e): e is string => !!e && !tried.has(e));
      discovered.forEach(e => tried.add(e));
      const viaDiscovery = await firstSuccess(discovered, 4);
      if (viaDiscovery) return viaDiscovery;

      const local = await deps.localAddress?.().catch(() => undefined);
      const m = local ? IPV4.exec(local) : null;
      if (!m || m.slice(1).some(n => Number(n) > 255)) return undefined;
      const own = Number(m[4]);
      const scan: string[] = [];
      for (let i = 1; i <= 254; i++) {
        if (i === own) continue;
        for (const p of ports) { const e = buildEndpoint(`${m[1]}.${m[2]}.${m[3]}.${i}`, p); if (e && !tried.has(e)) scan.push(e); }
      }
      return firstSuccess(scan, deps.scanConcurrency ?? 32);
    },
  };
}
