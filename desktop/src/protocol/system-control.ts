/** Defines System Control wire contracts (power, volume, brightness); depends on Zod; performs no OS calls itself. */
import { z } from 'zod';

export const powerActionSchema = z.enum(['lock', 'sleep', 'restart', 'shutdown']);
export type PowerAction = z.infer<typeof powerActionSchema>;
export const powerSchema = z.strictObject({ action: powerActionSchema });
export const powerResultSchema = z.strictObject({ status: z.literal('requested') });

export const volumeSetSchema = z.strictObject({ level: z.number().int().min(0).max(100), muted: z.boolean().optional() });
export const volumeStateSchema = z.strictObject({ level: z.number().int().min(0).max(100), muted: z.boolean() });
export const emptySystemSchema = z.strictObject({});

export const brightnessSetSchema = z.strictObject({ level: z.number().int().min(0).max(100) });
export const brightnessStateSchema = z.strictObject({ level: z.number().int().min(0).max(100).nullable() });
