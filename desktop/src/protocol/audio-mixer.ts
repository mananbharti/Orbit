/** Defines per-app audio mixer wire contracts; depends on Zod; performs no OS calls itself. */
import { z } from 'zod';

export const audioSessionIdSchema = z.string().regex(/^[0-9]{1,10}$/); // process ids only, never names or paths
export const audioSessionNameSchema = z.string().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
export const audioSessionSchema = z.strictObject({ id: audioSessionIdSchema, name: audioSessionNameSchema,
  volume: z.number().int().min(0).max(100), muted: z.boolean() });
export const audioSessionsResultSchema = z.strictObject({ sessions: z.array(audioSessionSchema).max(64) });
export const audioSessionSetSchema = z.strictObject({ id: audioSessionIdSchema,
  level: z.number().int().min(0).max(100).optional(), muted: z.boolean().optional() })
  .refine(value => value.level !== undefined || value.muted !== undefined);
export const audioAppliedSchema = z.strictObject({ applied: z.literal(true) });
