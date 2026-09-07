/** Defines the plain-text clipboard boundary; depends on Zod; does not read the OS clipboard or retain history. */
import { z } from 'zod';

export const MAX_CLIPBOARD_BYTES = 8 * 1_024;
export const CLIPBOARD_POLL_MS = 500;
// Native Unicode clipboard formats use NUL termination; reject text we cannot preserve exactly.
export const clipboardTextSchema = z.string().refine(text => !/[\uD800-\uDFFF]/u.test(text) && !text.includes('\0')
  && Buffer.byteLength(text, 'utf8') <= MAX_CLIPBOARD_BYTES);
export const clipboardSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: clipboardTextSchema }),
  z.strictObject({ kind: z.enum(['unsupported', 'oversized']) }),
]);
export type ClipboardSnapshot = z.infer<typeof clipboardSnapshotSchema>;

const subscriptionIdSchema = z.string().uuid();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const clipboardSubscribeSchema = z.strictObject({});
export const clipboardSubscriptionSchema = z.strictObject({ subscriptionId: subscriptionIdSchema, revision: revisionSchema });
export const clipboardUnsubscribeSchema = z.strictObject({ subscriptionId: subscriptionIdSchema });
export const clipboardWriteSchema = z.strictObject({ subscriptionId: subscriptionIdSchema,
  baseRevision: revisionSchema, text: clipboardTextSchema });
export const clipboardWriteResultSchema = z.strictObject({ status: z.enum(['applied', 'unchanged', 'conflict']), revision: revisionSchema });
export const clipboardChangedSchema = z.strictObject({ subscriptionId: subscriptionIdSchema, revision: revisionSchema, text: clipboardTextSchema });
export const clipboardStatusSchema = z.strictObject({ subscriptionId: subscriptionIdSchema, revision: revisionSchema,
  status: z.enum(['unsupported', 'oversized', 'unavailable']) });
