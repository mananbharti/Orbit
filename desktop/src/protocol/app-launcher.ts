/** Defines App Launcher wire contracts; depends on Zod; does not discover applications or authorize OS activation. */
import { z } from 'zod';

export const APP_PAGE_SIZE = 32;
export const MAX_APPS = 2_048;
export const appIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogRevisionSchema = z.string().uuid();
export const appNameSchema = z.string().min(1).max(256).refine(value => Buffer.byteLength(value, 'utf8') <= 256
  && !/[\x00-\x1f\x7f\uD800-\uDFFF]/u.test(value));
export const listAppsSchema = z.strictObject({ cursor: z.string().max(48).regex(/^[a-f0-9-]{36}:[0-9]{1,4}$/).optional() });
export const launchAppSchema = z.strictObject({ appId: appIdSchema, catalogRevision: catalogRevisionSchema });
export const appPageSchema = z.strictObject({ catalogRevision: catalogRevisionSchema,
  apps: z.array(z.strictObject({ appId: appIdSchema, name: appNameSchema })).max(APP_PAGE_SIZE),
  nextCursor: z.string().max(48).nullable() });
export const launchResultSchema = z.strictObject({ status: z.literal('requested') });
export type AppPage = z.infer<typeof appPageSchema>;
