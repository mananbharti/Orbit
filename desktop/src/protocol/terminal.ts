/** Remote-terminal wire contract: payloads and validation only; depends on zod. */
import { z } from 'zod';

export const MAX_TERMINAL_COMMAND = 4_000;
/** Total captured output per command; past this the command is killed and the reply is marked truncated. Stays under the 64KB message cap. */
export const MAX_TERMINAL_OUTPUT = 48 * 1024;
/** One event carries at most this much text. */
export const TERMINAL_CHUNK = 4 * 1024;
export const TERMINAL_DEFAULT_TIMEOUT_MS = 60_000;
export const TERMINAL_MAX_TIMEOUT_MS = 120_000;
/** A session with no command activity for this long closes itself. */
export const TERMINAL_IDLE_MS = 5 * 60_000;

export const terminalSessionSchema = z.strictObject({ sessionId: z.string().uuid() });
export const terminalExecSchema = z.strictObject({ sessionId: z.string().uuid(),
  command: z.string().min(1).max(MAX_TERMINAL_COMMAND),
  timeoutMs: z.number().int().min(1_000).max(TERMINAL_MAX_TIMEOUT_MS).optional() });
export const terminalBeginResultSchema = z.strictObject({ sessionId: z.string().uuid(), cwd: z.string().min(1).max(1024),
  idleTimeoutMs: z.number().int().positive() });
export const terminalExecResultSchema = z.strictObject({ exitCode: z.number().int().nullable(),
  cwd: z.string().min(1).max(1024), truncated: z.boolean(), timedOut: z.boolean() });
export const terminalOutputEventSchema = z.strictObject({ sessionId: z.string().uuid(),
  stream: z.enum(['stdout', 'stderr']), data: z.string().max(TERMINAL_CHUNK) });
