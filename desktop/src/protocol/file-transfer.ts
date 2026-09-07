/** Defines version 1 File Transfer messages and limits; depends on Zod; does not access paths, authorize peers or store data. */
import { z } from 'zod';

export const CHUNK_BYTES = 32 * 1_024;
export const MAX_CHUNK_BASE64_BYTES = 4 * Math.ceil(CHUNK_BYTES / 3);
export const MAX_FILE_BYTES = 1_024 ** 3;
export const MAX_PARTIAL_BYTES = 4 * MAX_FILE_BYTES;
export const MAX_ACTIVE_TRANSFERS = 4;
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1_000;
export const PROGRESS_INTERVAL_MS = 250;
export const id = z.string().uuid().toLowerCase();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const offset = z.number().int().min(0).max(MAX_FILE_BYTES);
export const fileName = z.string().min(1).max(200).refine(name => Buffer.byteLength(name, 'utf8') <= 200
  && !/[\\/:*?"<>|\x00-\x1f\x7f\uD800-\uDFFF]/u.test(name) && !/[. ]$/.test(name)
  && !/^(\.|\.\.|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
export const manifestSchema = z.strictObject({ transferId: id, direction: z.enum(['to-desktop', 'to-client']),
  name: fileName, sizeBytes: offset, sha256: digest, chunkBytes: z.literal(CHUNK_BYTES) });
export const stateSchema = z.enum(['offered', 'transferring', 'paused', 'verifying', 'completed', 'cancelled', 'failed', 'expired']);
export const transferRef = z.strictObject({ transferId: id });
export const leaseRef = z.strictObject({ transferId: id, leaseId: id });
export const checkpointSchema = z.strictObject({ receivedBytes: offset, prefixSha256: digest });
export const resumeSchema = z.strictObject({ transferId: id, checkpoint: checkpointSchema.optional() });
export const chunkSchema = z.strictObject({ transferId: id, leaseId: id, offset,
  dataBase64: z.string().max(MAX_CHUNK_BASE64_BYTES), sha256: digest });
export const readSchema = leaseRef.extend({ offset });
export const ackSchema = leaseRef.extend({ nextOffset: offset, sha256: digest });
export const statusSchema = z.strictObject({ manifest: manifestSchema, state: stateSchema, nextOffset: offset,
  leaseId: id.optional(), error: z.string().regex(/^FILE_[A-Z_]+$/).optional() });
export const offersSchema = z.strictObject({ cursor: id.optional() });
export const emptySchema = z.strictObject({});
export const unsubscribeSchema = z.strictObject({ subscriptionId: id });
export type Manifest = z.infer<typeof manifestSchema>;
export type TransferState = z.infer<typeof stateSchema>;
export type TransferStatus = z.infer<typeof statusSchema>;
export const terminal = (state: TransferState): boolean => ['completed', 'cancelled', 'failed', 'expired'].includes(state);
