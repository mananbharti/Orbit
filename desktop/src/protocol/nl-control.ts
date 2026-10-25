/** Natural-language control wire contract; depends on Zod; no OS calls. */
import { z } from 'zod';

export const NL_MAX_TEXT = 200;
export const nlControlSchema = z.strictObject({ text: z.string().min(1).max(NL_MAX_TEXT) });

export const nlOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('executed'), command: z.string(), result: z.any() }),
  z.strictObject({ status: z.literal('rejected'), command: z.string(), error: z.string() }),
  z.strictObject({ status: z.literal('unclear'), hint: z.string() }),
  z.strictObject({ status: z.literal('unknown') }),
]);
export type NlOutcome = z.infer<typeof nlOutcomeSchema>;
