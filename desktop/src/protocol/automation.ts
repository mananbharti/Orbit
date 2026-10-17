/** Scheduled-action wire contract: payloads and validation only; depends on zod and the identifier schema. */
import { z } from 'zod';

export const MAX_AUTOMATIONS = 32;
export const automationTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/); // local desktop time, 24h
export const automationDaySchema = z.number().int().min(0).max(6); // 0 = Sunday
export const automationActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('scene'), sceneId: z.string().uuid() }),
  z.strictObject({ type: z.literal('app'), appId: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal('power'), action: z.enum(['sleep', 'lock']) }),
]);
export const automationSchema = z.strictObject({ id: z.string().uuid(), time: automationTimeSchema,
  days: z.array(automationDaySchema).max(7), // empty means every day
  enabled: z.boolean(), action: automationActionSchema,
  lastFiredAt: z.number().int().nonnegative().optional() });
export type Automation = z.infer<typeof automationSchema>;
export type AutomationAction = Automation['action'];

export const saveAutomationSchema = z.strictObject({ id: z.string().uuid().optional(), time: automationTimeSchema,
  days: z.array(automationDaySchema).max(7), action: automationActionSchema });
export const automationIdSchema = z.strictObject({ id: z.string().uuid() });
export const setAutomationEnabledSchema = z.strictObject({ id: z.string().uuid(), enabled: z.boolean() });
export const automationListResultSchema = z.strictObject({ automations: z.array(automationSchema).max(MAX_AUTOMATIONS) });
