/** Payload schemas for the tabs.* command family; depends on zod only. */
import { z } from 'zod';

export const tabIdSchema = z.strictObject({ tabId: z.number().int().positive() });
export const openTabSchema = z.strictObject({ url: z.string().url().max(2048).refine(u => u.startsWith('https://') || u.startsWith('http://'), 'http(s) only') });

export const tabSchema = z.strictObject({ id: z.number().int(), title: z.string(), url: z.string(), active: z.boolean(), windowId: z.number().int() });
export const tabListSchema = z.strictObject({ tabs: z.array(tabSchema).max(500) });
export type BrowserTab = z.infer<typeof tabSchema>;
