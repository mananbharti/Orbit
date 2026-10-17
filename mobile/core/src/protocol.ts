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

const macAddressSchema = z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
export const pairingPayloadSchema = z.strictObject({
  version: z.literal(1), desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  endpoint: endpointSchema, certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pairingToken: tokenSchema, expiresAt: z.number().int().positive(),
  /** Real NIC addresses for Wake-on-LAN; absent when the desktop could not list them. */
  macAddresses: z.array(macAddressSchema).max(4).optional(),
});
export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export const pairedResponseSchema = z.strictObject({ version: z.literal(1),
  desktopServiceId: idSchema, deviceId: idSchema, credential: tokenSchema });
export const sessionResponseSchema = z.strictObject({ version: z.literal(1),
  deviceId: idSchema, sessionId: idSchema, expiresAt: z.number().int().positive(), sessionToken: tokenSchema,
  scopes: z.array(z.string().max(24)).max(16).optional() }); // older desktops echo the device's scopes

/** The seven permissions a desktop can grant a device; mirrors the desktop wire contract. */
export const SCOPES = ['agent', 'clipboard', 'files', 'launcher', 'input', 'dictation', 'memory'] as const;
export type Scope = (typeof SCOPES)[number];
export const deviceInfoSchema = z.strictObject({ deviceId: idSchema,
  scopes: z.union([z.array(z.enum(SCOPES)).min(1).max(SCOPES.length), z.literal('all')]) });
export const pairDevicesResultSchema = z.strictObject({ current: idSchema, devices: z.array(deviceInfoSchema).max(128) });
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** What the phone persists (in the OS secure store) after pairing. */
export const pairedDesktopSchema = z.strictObject({ desktopServiceId: idSchema, displayName: z.string().min(1).max(64),
  deviceId: idSchema, endpoint: endpointSchema, certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  credential: tokenSchema, macAddresses: z.array(macAddressSchema).max(4).optional() });
export type PairedDesktop = z.infer<typeof pairedDesktopSchema>;

export const ERROR_CODES = ['INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNAUTHENTICATED', 'UNKNOWN_COMMAND',
  'INVALID_PAYLOAD', 'BIOMETRIC_REQUIRED', 'COMMAND_FAILED', 'DUPLICATE_REQUEST', 'BUSY',
  'CLIPBOARD_UNAVAILABLE', 'CLIPBOARD_NOT_SUBSCRIBED', 'CLIPBOARD_NOT_FOUND',
  'FILE_NOT_FOUND', 'FILE_INVALID_STATE', 'FILE_INVALID_LEASE', 'FILE_QUOTA', 'FILE_OFFSET', 'FILE_INTEGRITY',
  'FILE_SOURCE_CHANGED', 'FILE_IO', 'FILE_EXPIRED',
  'LAUNCHER_UNAVAILABLE', 'LAUNCHER_LIMIT', 'LAUNCHER_STALE_CATALOG', 'LAUNCHER_STALE_LAYOUT', 'LAUNCHER_NOT_FOUND', 'LAUNCHER_SCENE_CONFLICT', 'LAUNCHER_UNKNOWN_OUTCOME',
  'INPUT_UNAVAILABLE', 'INPUT_SESSION_REQUIRED', 'INPUT_SEQUENCE', 'INPUT_CONFLICT', 'INPUT_NOT_FOUND',
  'AGENT_NOT_FOUND', 'AGENT_INVALID_STATE', 'AGENT_LIMIT', 'AGENT_LEDGER_IO', 'AGENT_PAUSED', 'SCOPE_DENIED', 'SYSTEM_UNAVAILABLE',
  'PAIR_NOT_FOUND', 'PAIR_SELF_SCOPES'] as const;
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

export const auditEntrySchema = z.strictObject({ at: z.number().int().min(0), taskId: z.string().uuid().optional(), deviceId: z.string().uuid(),
  kind: z.enum(['submitted', 'approval-requested', 'approved', 'denied', 'approval-timeout', 'cancelled-by-user', 'finished', 'paused', 'resumed']),
  outcome: z.string().max(32).optional() });
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditPageSchema = z.strictObject({ entries: z.array(auditEntrySchema).max(50) });

export const safeModeSchema = z.strictObject({ paused: z.boolean() });

// App launcher (mirrors desktop/src/protocol/app-launcher.ts).
export const APP_PAGE_SIZE = 32;
export const MAX_APPS = 2_048;
export const appSchema = z.strictObject({ appId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(256) });
export type AppEntry = z.infer<typeof appSchema>;
export const MAX_PINS = 24;
export const appPageSchema = z.strictObject({ catalogRevision: z.string().uuid(), apps: z.array(appSchema).max(APP_PAGE_SIZE),
  nextCursor: z.string().max(48).nullable(), pinned: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_PINS) });
export const launcherLayoutSchema = z.strictObject({ pinned: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_PINS) });

// Launcher scenes (mirrors desktop/src/protocol/app-launcher.ts).
export const MAX_SCENES = 20;
export const MAX_SCENE_APPS = 12;
export const launcherSceneSchema = z.strictObject({ id: z.string().uuid(), name: z.string().min(1).max(40),
  appIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(MAX_SCENE_APPS) });
export type LauncherScene = z.infer<typeof launcherSceneSchema>;
export const launcherScenesSchema = z.strictObject({ scenes: z.array(launcherSceneSchema).max(MAX_SCENES) });
export const sceneLaunchResultSchema = z.strictObject({ launched: z.number().int().min(0).max(MAX_SCENE_APPS),
  failed: z.array(z.string().min(1).max(256)).max(MAX_SCENE_APPS) });
export const launchResultSchema = z.strictObject({ status: z.literal('requested') });
export const appIconResultSchema = z.strictObject({ icon: z.string().base64().max(90_000).nullable() });
export const ICON_BATCH_SIZE = 8;
export const appIconsResultSchema = z.strictObject({ icons: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string().base64().max(90_000).nullable()) });

// Clipboard (mirrors desktop/src/protocol/clipboard.ts). Plain text only, 8 KiB.
export const MAX_CLIPBOARD_BYTES = 8 * 1024;
export const clipboardSubscriptionSchema = z.strictObject({ subscriptionId: z.string().uuid(), revision: z.number().int().min(0) });
export const clipboardWriteResultSchema = z.strictObject({ status: z.enum(['applied', 'unchanged', 'conflict']), revision: z.number().int().min(0) });
export const clipboardHistoryEntrySchema = z.strictObject({ id: z.string().uuid(), text: z.string(),
  at: z.number().int().positive(), source: z.enum(['pc', 'phone']) });
export const clipboardHistoryResultSchema = z.strictObject({ entries: z.array(clipboardHistoryEntrySchema).max(50), nextCursor: z.string().uuid().nullable() });
export type ClipboardHistoryEntry = z.infer<typeof clipboardHistoryEntrySchema>;
export const clipboardChangedSchema = z.strictObject({ subscriptionId: z.string().uuid(), revision: z.number().int().min(0), text: z.string() });
export const clipboardStatusSchema = z.strictObject({ subscriptionId: z.string().uuid(), revision: z.number().int().min(0),
  status: z.enum(['unsupported', 'oversized', 'unavailable']) });

// File transfer (mirrors desktop/src/protocol/file-transfer.ts). Explicitly selected files only, 32 KiB chunks, SHA-256 verified.
export const FILE_CHUNK_BYTES = 32 * 1_024;
export const MAX_FILE_BYTES = 1_024 ** 3;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const fileOffset = z.number().int().min(0).max(MAX_FILE_BYTES);
export const transferManifestSchema = z.strictObject({ transferId: z.string().uuid().toLowerCase(), direction: z.enum(['to-desktop', 'to-client']),
  name: z.string().min(1).max(200), sizeBytes: fileOffset, sha256: sha, chunkBytes: z.literal(FILE_CHUNK_BYTES) });
export type TransferManifest = z.infer<typeof transferManifestSchema>;
export const transferStateSchema = z.enum(['offered', 'transferring', 'paused', 'verifying', 'completed', 'cancelled', 'failed', 'expired']);
export type TransferState = z.infer<typeof transferStateSchema>;
export const transferStatusSchema = z.strictObject({ manifest: transferManifestSchema, state: transferStateSchema, nextOffset: fileOffset,
  leaseId: z.string().uuid().optional(), error: z.string().regex(/^FILE_[A-Z_]+$/).optional() });
export type TransferStatus = z.infer<typeof transferStatusSchema>;
export const fileChunkAckSchema = z.strictObject({ transferId: z.string().uuid(), nextOffset: fileOffset, state: transferStateSchema });
export const fileReadResultSchema = z.strictObject({ transferId: z.string().uuid(), offset: fileOffset, dataBase64: z.string().max(4 * Math.ceil(FILE_CHUNK_BYTES / 3)), sha256: sha });
export const fileOffersSchema = z.strictObject({ offers: z.array(transferManifestSchema).max(16), nextCursor: z.string().uuid().nullable() });
export const fileOfferedEventSchema = z.strictObject({ subscriptionId: z.string().uuid(), manifest: transferManifestSchema });
export const fileSubscriptionSchema = z.strictObject({ subscriptionId: z.string().uuid() });

// Remote pointer and keyboard (mirrors desktop/src/protocol/input.ts). Needs the computer owner's confirmation per session.
export const MAX_INPUT_EVENTS = 32;
export const MAX_POINTER_STEP = 2_000;
export const MAX_TEXT_CHARS = 64;
export const INPUT_KEYS = ['enter', 'backspace', 'delete', 'tab', 'escape', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'volumeup', 'volumedown', 'mute', 'playpause', 'next', 'previous',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
export type InputKey = (typeof INPUT_KEYS)[number];

// Keyboard macros (mirrors desktop/src/protocol/input.ts).
export const MAX_MACROS = 24;
export const MAX_MACRO_STEPS = 8;
export const macroStepSchema = z.strictObject({ key: z.enum(INPUT_KEYS), modifiers: z.array(z.enum(['shift', 'ctrl', 'alt', 'meta'])).max(4).optional() });
export type MacroStep = z.infer<typeof macroStepSchema>;
export const keyboardMacroSchema = z.strictObject({ id: z.string().uuid(), name: z.string().min(1).max(40),
  steps: z.array(macroStepSchema).min(1).max(MAX_MACRO_STEPS) });
export type KeyboardMacro = z.infer<typeof keyboardMacroSchema>;
export const keyboardMacrosSchema = z.strictObject({ macros: z.array(keyboardMacroSchema).max(MAX_MACROS) });
export type InputModifier = 'shift' | 'ctrl' | 'alt' | 'meta';
export type InputEvent =
  | { t: 'move'; dx: number; dy: number }
  | { t: 'button'; button: 'left' | 'right' | 'middle'; action: 'down' | 'up' | 'click' }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'key'; key: InputKey; modifiers?: InputModifier[]; action?: 'tap' | 'down' | 'up' }
  | { t: 'text'; text: string };
export const inputBeginSchema = z.strictObject({ controlSessionId: z.string().uuid(), nextSequence: z.number().int().min(1), heartbeatTimeoutMs: z.number().int().positive() });
export const inputSentSchema = z.strictObject({ nextSequence: z.number().int().min(2) });

// Dictation (mirrors desktop/src/protocol/dictation.ts). The phone streams 16 kHz mono 16-bit PCM; the computer returns text.
export const DICTATION_CHUNK_SAMPLES = 16 * 1_024;
export const MAX_DICTATION_SAMPLES = 16_000 * 120;
export const dictationBeginSchema = z.strictObject({ dictationId: z.string().uuid() });
export const MAX_COMPRESSED_BYTES = 3 * 1_024 * 1_024; // mirrors the desktop limit
export const dictationChunkSchema = z.strictObject({ nextOffset: z.number().int().min(1).max(MAX_COMPRESSED_BYTES) });
export const dictationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('text'), text: z.string().min(1).max(20_000) }),
  z.strictObject({ status: z.literal('no-speech') })]);
export type DictationResult = z.infer<typeof dictationResultSchema>;
