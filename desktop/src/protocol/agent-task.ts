/** Defines Agent Task wire contracts; depends on Zod; does not run agents, store tasks or authorize actions. */
import { z } from 'zod';

export const MAX_TASK_PROMPT_BYTES = 8 * 1_024;
export const MAX_TASK_EVENTS_PAGE = 64;
export const taskIdSchema = z.string().uuid().toLowerCase();
export const taskPromptSchema = z.string().min(1).refine(text => !/[\uD800-\uDFFF\0]/u.test(text)
  && Buffer.byteLength(text, 'utf8') <= MAX_TASK_PROMPT_BYTES);
export const taskStateSchema = z.enum(['queued', 'running', 'awaiting-approval', 'paused', 'completed', 'failed', 'cancelled', 'unknown']);
export type TaskState = z.infer<typeof taskStateSchema>;
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled']);

export const retryTaskSchema = z.strictObject({ taskId: taskIdSchema, idempotencyKey: z.string().uuid() });
export const submitTaskSchema = z.strictObject({ prompt: taskPromptSchema, idempotencyKey: z.string().uuid() });
export const taskRefSchema = z.strictObject({ taskId: taskIdSchema });
export const taskSummarySchema = z.strictObject({ taskId: taskIdSchema, state: taskStateSchema,
  createdAt: z.number().int().min(0), updatedAt: z.number().int().min(0), headline: z.string().max(200) });
export const taskEventsQuerySchema = z.strictObject({ taskId: taskIdSchema, afterSeq: z.number().int().min(0).default(0) });
export const taskEventSchema = z.strictObject({ seq: z.number().int().min(1), at: z.number().int().min(0),
  kind: z.enum(['state', 'step', 'output', 'approval-request']), text: z.string().max(2_000) });
export const taskEventsPageSchema = z.strictObject({ events: z.array(taskEventSchema).max(MAX_TASK_EVENTS_PAGE), hasMore: z.boolean() });
export type TaskSummary = z.infer<typeof taskSummarySchema>;
