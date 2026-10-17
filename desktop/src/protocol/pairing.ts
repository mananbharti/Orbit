/** Validates QR and pairing response contracts; depends on Zod; does not establish trust or enroll devices. */
import { z } from 'zod';
import { isLocalAddress } from '../config.js';
import { IDENTIFIER_PATTERN } from './validation.js';

export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const idSchema = z.string().regex(IDENTIFIER_PATTERN);
export const endpointSchema = z.string().max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && isLocalAddress(url.hostname.replace(/^\[|\]$/g, ''))
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/v1/channel';
  } catch { return false; }
});
export const macAddressSchema = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
export const pairingPayloadSchema = z.strictObject({
  version: z.literal(1), desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  endpoint: endpointSchema, certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pairingToken: tokenSchema, expiresAt: z.number().int().positive(),
  /** Real NIC addresses, so a paired phone can wake this machine later. Absent on unknown platforms. */
  macAddresses: z.array(macAddressSchema).max(4).optional(),
});
export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export const pairedResponseSchema = z.strictObject({ version: z.literal(1),
  desktopServiceId: idSchema, deviceId: idSchema, credential: tokenSchema });
export const sessionResponseSchema = z.strictObject({ version: z.literal(1),
  deviceId: idSchema, sessionId: idSchema, expiresAt: z.number().int().positive(), sessionToken: tokenSchema });

/** Permission scopes a paired device may hold; the wire contract, mirrored by security-pairing/scopes.ts. */
export const SCOPES = ['agent', 'clipboard', 'files', 'launcher', 'input', 'dictation', 'memory'] as const;
export const scopeSchema = z.enum(SCOPES);
export const deviceInfoSchema = z.strictObject({ deviceId: z.string().uuid(),
  scopes: z.union([z.array(scopeSchema).min(1).max(SCOPES.length), z.literal('all')]) });
export const pairDevicesResultSchema = z.strictObject({ current: z.string().uuid(), devices: z.array(deviceInfoSchema).max(128) });
export const revokeDeviceSchema = z.strictObject({ deviceId: z.string().uuid() });
export const setDeviceScopesSchema = z.strictObject({ deviceId: z.string().uuid(),
  scopes: z.union([z.array(scopeSchema).min(1).max(SCOPES.length), z.literal('all')]) });
