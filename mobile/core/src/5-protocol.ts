/** Wire contracts the phone shares with Orbit Desktop; depends on Zod; does not open sockets or hold secrets. */
import { z } from 'zod';

export const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COMMAND = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/;
export const MAX_MESSAGE_BYTES = 64 * 1024;

const idSchema = z.string().regex(IDENTIFIER);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Mirrors the desktop rule: loopback, RFC 1918 and link-local IPv4, or ::1. Hostnames are never accepted. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const n = m.slice(1).map(Number);
  if (n.some(x => x > 255)) return false;
  const [a, b] = n as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export const endpointSchema = z.string().max(256).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && isLocalHost(url.hostname) && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === '/v1/channel';
  } catch { return false; }
}, 'Endpoint must be a local wss:// /v1/channel address');

export const pairingPayloadSchema = z.strictObject({
  version: z.literal(1), desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  endpoint: endpointSchema, certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pairingToken: tokenSchema, expiresAt: z.number().int().positive(),
});
export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export const pairedResponseSchema = z.strictObject({ version: z.literal(1),
  desktopServiceId: idSchema, deviceId: idSchema, credential: tokenSchema });
export const sessionResponseSchema = z.strictObject({ version: z.literal(1),
  deviceId: idSchema, sessionId: idSchema, expiresAt: z.number().int().positive(), sessionToken: tokenSchema });

/** What the phone persists (in the OS secure store) after pairing. */
export const pairedDesktopSchema = z.strictObject({ desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  deviceId: idSchema, endpoint: endpointSchema, certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  credential: tokenSchema });
export type PairedDesktop = z.infer<typeof pairedDesktopSchema>;

export const ERROR_CODES = ['INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNAUTHENTICATED', 'UNKNOWN_COMMAND',
  'INVALID_PAYLOAD', 'BIOMETRIC_REQUIRED', 'COMMAND_FAILED', 'DUPLICATE_REQUEST', 'BUSY',
  'CLIPBOARD_UNAVAILABLE', 'CLIPBOARD_NOT_SUBSCRIBED',
  'FILE_NOT_FOUND', 'FILE_INVALID_STATE', 'FILE_INVALID_LEASE', 'FILE_QUOTA', 'FILE_OFFSET', 'FILE_INTEGRITY',
  'FILE_SOURCE_CHANGED', 'FILE_IO', 'FILE_EXPIRED',
  'LAUNCHER_UNAVAILABLE', 'LAUNCHER_LIMIT', 'LAUNCHER_STALE_CATALOG', 'LAUNCHER_NOT_FOUND', 'LAUNCHER_UNKNOWN_OUTCOME',
  'INPUT_UNAVAILABLE', 'INPUT_SESSION_REQUIRED', 'INPUT_SEQUENCE',
  'AGENT_NOT_FOUND', 'AGENT_INVALID_STATE', 'AGENT_LIMIT', 'AGENT_LEDGER_IO'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const responseSchema = z.strictObject({ version: z.literal(1), type: z.literal('response'),
  requestId: z.string().regex(IDENTIFIER).nullable(), payload: z.union([
    z.strictObject({ ok: z.literal(true), result: z.unknown() }),
    z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(ERROR_CODES) }) }),
  ]) });
export const eventSchema = z.strictObject({ version: z.literal(1), type: z.literal('event'), requestId: z.null(),
  payload: z.strictObject({ eventType: z.string().max(64).regex(COMMAND), data: z.unknown() }) });
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Agent tasks (mirrors desktop/src/protocol/agent-task.ts).
export const taskStateSchema = z.enum(['queued', 'running', 'awaiting-approval', 'paused', 'completed', 'failed', 'cancelled', 'unknown']);
export type TaskState = z.infer<typeof taskStateSchema>;
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled']);
export const taskSummarySchema = z.strictObject({ taskId: z.string().uuid(), state: taskStateSchema,
  createdAt: z.number().int().min(0), updatedAt: z.number().int().min(0), headline: z.string().max(200) });
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const taskEventSchema = z.strictObject({ seq: z.number().int().min(1), at: z.number().int().min(0),
  kind: z.enum(['state', 'step', 'output', 'approval-request']), text: z.string().max(2_000) });
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskEventsPageSchema = z.strictObject({ events: z.array(taskEventSchema).max(64), hasMore: z.boolean() });
export const taskListSchema = z.strictObject({ tasks: z.array(taskSummarySchema) });
export const approvalResultSchema = z.strictObject({ status: z.enum(['approved', 'denied']) });
export const MAX_TASK_PROMPT_BYTES = 8 * 1024;
