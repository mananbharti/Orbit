/** Defines dictation messages: the phone streams one short clip, the desktop returns text; depends on Zod; does not run an engine or authorize peers. */
import { z } from 'zod';

export const DICTATION_CHUNK_BYTES = 32 * 1_024;
export const MAX_DICTATION_SAMPLES = 16_000 * 120;
export const MAX_COMPRESSED_BYTES = 3 * 1_024 * 1_024;
export const DICTATION_TTL_MS = 150_000;
const id = z.string().uuid();
export const beginSchema = z.strictObject({ format: z.enum(['pcm16', 'm4a']).optional(), language: z.string().regex(/^(?:[a-z]{2,3}|auto)$/).optional() });
export const chunkSchema = z.strictObject({ dictationId: id, offset: z.number().int().min(0).max(MAX_COMPRESSED_BYTES),
  dataBase64: z.string().min(4).max(4 * Math.ceil(DICTATION_CHUNK_BYTES / 3)) });
export const refSchema = z.strictObject({ dictationId: id });
