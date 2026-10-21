/** Publishes and discovers untrusted LAN hints; depends on Bonjour and public certificates; never advertises enrollment or session secrets. */
import Bonjour from 'bonjour-service';
import { X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { endpointSchema, idSchema } from '../../protocol/pairing.js';
import { certificateFingerprint } from '../../security-pairing/desktop-identity.js';

const SERVICE_TYPE = 'orbit';
const TXT_CHUNK_SIZE = 200;
const MAX_CERTIFICATE_CHUNKS = 8;
const hintSchema = z.strictObject({ desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  endpoint: endpointSchema, certificate: z.string().max(4_096) });
export type DesktopHint = z.infer<typeof hintSchema>;

export function encodeAdvertisement(hint: DesktopHint): Record<string, string> {
  hintSchema.parse(hint);
  const encoded = new X509Certificate(hint.certificate).raw.toString('base64');
  const chunks = encoded.match(new RegExp(`.{1,${TXT_CHUNK_SIZE}}`, 'g'))!;
  if (chunks.length > MAX_CERTIFICATE_CHUNKS) throw new Error('Certificate exceeds discovery limit');
  return { version: '1', id: hint.desktopServiceId, name: hint.displayName,
    endpoint: hint.endpoint, parts: String(chunks.length),
    ...Object.fromEntries(chunks.map((chunk, i) => [`cert${i}`, chunk])) };
}

export function decodeAdvertisement(txt: unknown): DesktopHint | undefined {
  try {
    const fields = z.record(z.string(), z.string().max(256)).parse(txt);
    const count = Number(fields.parts);
    if (fields.version !== '1' || !Number.isInteger(count) || count < 1 || count > MAX_CERTIFICATE_CHUNKS
      || Object.keys(fields).length !== count + 5) return undefined;
    let encoded = '';
    for (let i = 0; i < count; i++) {
      const part = fields[`cert${i}`];
      if (!part || part.length > TXT_CHUNK_SIZE || !/^[A-Za-z0-9+/=]+$/.test(part)) return undefined;
      encoded += part;
    }
    const certificate = new X509Certificate(Buffer.from(encoded, 'base64')).toString();
    return hintSchema.parse({ desktopServiceId: fields.id, displayName: fields.name, endpoint: fields.endpoint, certificate });
  } catch { return undefined; }
}

/** Injectable for tests: the real Bonjour constructor. */
type BonjourFactory = (onError: () => void) => Bonjour;
const realBonjour: BonjourFactory = onError => new Bonjour(undefined, onError);

export function advertiseDesktop(hint: DesktopHint, onError: () => void, createBonjour: BonjourFactory = realBonjour): { stop(): Promise<void> } {
  const txt = encodeAdvertisement(hint);
  const bonjour = createBonjour(onError);
  const service = bonjour.publish({ name: `Orbit-${hint.desktopServiceId}`, type: SERVICE_TYPE,
    port: Number(new URL(hint.endpoint).port || 443), txt, disableIPv6: true });
  service.on('error', onError);
  return { stop: () => new Promise<void>(resolve => {
    let settled = false;
    const settle = () => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(hangGuard); resolve(); } };
    // A wedged multicast socket can leave destroy's callback uncalled; stop must still settle.
    const hangGuard = setTimeout(settle, 2_000);
    hangGuard.unref();
    let destroying = false;
    const destroy = () => { if (!settled && !destroying) { destroying = true; clearTimeout(timer); bonjour.destroy(settle); } };
    const timer = setTimeout(destroy, 1_000);
    service.stop(destroy);
  }) };
}

export function discoverDesktop(expected: { desktopServiceId: string; certificateFingerprint: string },
  timeoutMs = 10_000, signal?: AbortSignal, createBonjour: BonjourFactory = realBonjour): Promise<DesktopHint> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let browser: ReturnType<Bonjour['find']> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let hangGuard: NodeJS.Timeout | undefined;
    const bonjour = createBonjour(() => finish());
    const aborted = () => finish();
    let settled = false;
    function settle(hint?: DesktopHint) {
      if (settled) return;
      settled = true;
      clearTimeout(hangGuard);
      if (hint) resolve(hint);
      else reject(new Error('LAN discovery unavailable or timed out'));
    }
    function finish(hint?: DesktopHint) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      browser?.stop();
      // A wedged multicast socket can leave destroy's callback uncalled; settle anyway.
      hangGuard = setTimeout(() => settle(hint), 2_000);
      hangGuard.unref();
      bonjour.destroy(() => settle(hint));
    }
    browser = bonjour.find({ type: SERVICE_TYPE }, service => {
      const hint = decodeAdvertisement(service.txt);
      if (hint?.desktopServiceId === expected.desktopServiceId
        && certificateFingerprint(hint.certificate) === expected.certificateFingerprint) finish(hint);
    });
    timer = setTimeout(() => finish(), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) finish();
  });
}
